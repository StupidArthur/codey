import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createHash, randomUUID } from 'node:crypto'
import { readdir, readFile, stat } from 'node:fs/promises'
import { join, relative } from 'node:path'
import type { EvidenceSummary, ExecutionOutcome, RunnerEvent } from '../../shared/contracts'
import type {
  CollectResult, EvidenceBundle, FileState, FileStateMap, ToolCallFact, VerificationRun, WorkspaceSnapshot
} from './evidence'

const run = promisify(execFile)
const MAX_DIFF = 4_000
const MAX_FILES = 200
const MAX_WALK = 4_000
/** Content hashes are computed for files up to this size (same-size/same-mtime detection). */
const HASH_CAP_BYTES = 1_000_000

interface FileStamp {
  mtimeMs: number
  size: number
  hash?: string
}

/**
 * Reads the real workspace before and after an execution; never trusts model
 * claims. Verification verdicts are never derived from Runner events or tool
 * titles: the loop feeds this collector with `ToolCallFact`s (observed facts
 * only) and the product's verification executor runs (the only source of
 * `passed`/`failed`).
 */
export class EvidenceCollector {
  /** Capture the state before the round starts (records pre-existing changes). */
  async baseline(workspacePath: string): Promise<WorkspaceSnapshot> {
    const git = await isGitRepo(workspacePath)
    const files = await snapshotFiles(workspacePath)
    const dirty = git ? await gitStatus(workspacePath) : new Map<string, string>()
    const preexisting = new Set(dirty.keys())
    return {
      git,
      preexisting,
      files,
      dirty,
      fileStates: toFileStates(files, null)
    }
  }

  /**
   * Diff the workspace against both the round-start snapshot (round-so-far
   * changes) and the previous turn's snapshot (this turn's delta).
   */
  async collect(
    workspacePath: string,
    startSnapshot: WorkspaceSnapshot,
    prevSnapshot: WorkspaceSnapshot,
    _events: RunnerEvent[],
    toolFacts: ToolCallFact[],
    outcome: ExecutionOutcome
  ): Promise<CollectResult> {
    const isGit = await isGitRepo(workspacePath)
    const files = await snapshotFiles(workspacePath)
    const dirty = isGit ? await gitStatus(workspacePath) : new Map<string, string>()

    const changedFiles = isGit
      ? [...dirty.keys()].filter((file) => !startSnapshot.preexisting.has(file))
      : changedSinceFiles(startSnapshot.files, files)
    const turnChangedFiles = isGit
      ? [...dirty.keys()].filter((file) => !prevSnapshot.dirty.has(file))
      : changedSinceFiles(prevSnapshot.files, files)
    const newFiles = changedFiles.filter((file) =>
      isGit ? (dirty.get(file) ?? '').startsWith('?') : !startSnapshot.files.has(file)
    )

    let gitDiffSummary: string | undefined
    if (isGit) {
      const diff = await git(workspacePath, ['diff', '--stat'])
      if (diff?.trim()) gitDiffSummary = diff.trim().slice(0, MAX_DIFF)
    }

    const bundle: EvidenceBundle = {
      changedFiles: dedupe(changedFiles).slice(0, MAX_FILES),
      turnChangedFiles: dedupe(turnChangedFiles).slice(0, MAX_FILES),
      newFiles: dedupe(newFiles).slice(0, MAX_FILES),
      preexistingChanges: [...startSnapshot.preexisting].slice(0, MAX_FILES),
      ...(gitDiffSummary ? { gitDiffSummary } : {}),
      toolFacts,
      verification: [],
      outcome
    }

    const snapshot: WorkspaceSnapshot = { git: isGit, preexisting: startSnapshot.preexisting, files, dirty, fileStates: toFileStates(files, startSnapshot.files) }
    return { bundle, snapshot }
  }

  /** Current file states (including deletions relative to the baseline). */
  currentFileStates(workspacePath: string, baseline: WorkspaceSnapshot): Promise<FileStateMap> {
    return snapshotFiles(workspacePath).then((files) => toFileStates(files, baseline.files))
  }

  toRecords(bundle: EvidenceBundle): EvidenceSummary[] {
    const at = (offset: number): string => new Date(Date.now() + offset).toISOString()
    const records: EvidenceSummary[] = []
    bundle.changedFiles.forEach((file, index) => {
      records.push({
        id: randomUUID(), kind: 'workspace', label: file,
        detail: bundle.newFiles.includes(file) ? 'created' : 'modified', outcome: 'observed',
        provenance: 'tool', observedAt: at(index)
      })
    })
    if (bundle.gitDiffSummary) {
      records.push({ id: randomUUID(), kind: 'workspace', label: 'git diff --stat', detail: bundle.gitDiffSummary, outcome: 'observed', provenance: 'tool', observedAt: at(records.length) })
    }
    for (const fact of bundle.toolFacts) {
      records.push({
        id: randomUUID(), kind: 'runtime', label: `tool ${fact.title}`,
        detail: `${fact.title} ${fact.status}`, outcome: 'observed', provenance: 'tool',
        observedAt: fact.at, toolCallId: fact.toolCallId, turn: fact.turn
      })
    }
    for (const run of bundle.verification) {
      records.push({
        id: run.id, kind: 'command', label: run.label, detail: runDetail(run),
        // The DB outcome domain is passed/failed/observed; a denial is stored
        // as observed plus its structured reason and reconstructed on read.
        outcome: run.outcome === 'denied' ? 'observed' : run.outcome,
        provenance: 'tool', observedAt: run.at, command: run.command, exitCode: run.exitCode,
        targets: run.targets, facts: run.facts,
        ...(run.denial ? { denial: run.denial } : {}),
        turn: run.turn
      })
    }
    return records
  }
}

function runDetail(run: VerificationRun): string {
  if (run.outcome === 'denied') return `denied — ${run.denial ?? 'executor refused the check'}`
  if (run.method === 'builtin') {
    const fact = run.facts[0]
    if (fact?.kind === 'file-exists') return fact.matched ? 'file exists' : fact.isFile ? 'missing' : 'path exists but is not a regular file'
    if (fact?.kind === 'content-equals') {
      return fact.matched
        ? `content match (sha1 ${fact.actualHash})`
        : `content mismatch (expected sha1 ${fact.expectedHash}, actual ${fact.actualHash ?? 'n/a'})`
    }
    if (fact?.kind === 'field-equals') {
      return fact.matched
        ? `field '${fact.key}' = '${fact.expected}'`
        : `field '${fact.key}' is ${fact.actual === null ? 'missing' : `'${fact.actual}'`}, expected '${fact.expected}'`
    }
    return run.outputTail || 'builtin check'
  }
  const tail = run.outputTail ? ` — ${run.outputTail}` : ''
  return `exit ${run.exitCode === null ? 'n/a' : run.exitCode}${tail}`
}

async function isGitRepo(workspacePath: string): Promise<boolean> {
  return (await git(workspacePath, ['rev-parse', '--is-inside-work-tree']))?.trim() === 'true'
}

async function gitStatus(workspacePath: string): Promise<Map<string, string>> {
  const out = await git(workspacePath, ['status', '--porcelain'])
  const dirty = new Map<string, string>()
  for (const line of (out ?? '').split('\n')) {
    const path = line.slice(3).trim()
    if (path) dirty.set(path, line.slice(0, 2))
  }
  return dirty
}

async function git(workspacePath: string, args: string[]): Promise<string | null> {
  try {
    const { stdout } = await run('git', ['-C', workspacePath, ...args], { maxBuffer: 8 * 1024 * 1024, windowsHide: true })
    return stdout
  } catch {
    return null
  }
}

/** Relative path → stamp for every ordinary file reachable within depth 3. */
async function snapshotFiles(root: string): Promise<Map<string, FileStamp>> {
  const found = new Map<string, FileStamp>()
  const queue: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }]
  let visited = 0
  while (queue.length > 0 && visited < MAX_WALK && found.size < MAX_FILES) {
    const { dir, depth } = queue.shift()!
    let entries
    try { entries = await readdir(dir, { withFileTypes: true }) } catch { continue }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue
      const full = join(dir, entry.name)
      visited += 1
      if (entry.isDirectory()) {
        if (depth < 3) queue.push({ dir: full, depth: depth + 1 })
        continue
      }
      if (!entry.isFile()) continue
      try {
        const info = await stat(full)
        const stamp: FileStamp = { mtimeMs: info.mtimeMs, size: info.size }
        if (info.size <= HASH_CAP_BYTES) {
          try {
            stamp.hash = createHash('sha1').update(await readFile(full)).digest('hex')
          } catch { /* unreadable: fall back to mtime/size only */ }
        }
        found.set(relative(root, full).replace(/\\/g, '/'), stamp)
      } catch { /* ignore */ }
    }
  }
  return found
}

/** Files that appeared, were touched, or disappeared between two snapshots. */
function changedSinceFiles(before: Map<string, FileStamp>, after: Map<string, FileStamp>): string[] {
  const changed: string[] = []
  for (const [file, stamp] of after) {
    const prev = before.get(file)
    const contentChanged = prev?.hash !== undefined && stamp.hash !== undefined && prev.hash !== stamp.hash
    if (prev === undefined || prev.mtimeMs !== stamp.mtimeMs || prev.size !== stamp.size || contentChanged) changed.push(file)
  }
  for (const file of before.keys()) {
    if (!after.has(file)) changed.push(file)
  }
  return changed
}

function toFileStates(files: Map<string, FileStamp>, baseline: Map<string, FileStamp> | null): FileStateMap {
  const states: FileStateMap = new Map()
  for (const [file, stamp] of files) {
    states.set(file, { exists: true, mtimeMs: stamp.mtimeMs, size: stamp.size, ...(stamp.hash ? { hash: stamp.hash } : {}) })
  }
  if (baseline) {
    for (const file of baseline.keys()) {
      if (!states.has(file)) states.set(file, { exists: false, mtimeMs: 0, size: 0 })
    }
  }
  return states
}

function dedupe(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))]
}

export type { FileState, FileStateMap }
