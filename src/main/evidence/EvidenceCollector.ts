import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { randomUUID } from 'node:crypto'
import { readdir, stat } from 'node:fs/promises'
import { join, relative } from 'node:path'
import type { EvidenceSummary, ExecutionOutcome, RunnerEvent } from '../../shared/contracts'

const run = promisify(execFile)
const MAX_DIFF = 4_000
const MAX_FILES = 200
const MAX_WALK = 4_000
const VERIFICATION_LABEL = /test|vitest|jest|typecheck|tsc|build|lint|compile/i

export interface WorkspaceBaseline {
  git: boolean
  /**
   * Non-git workspaces: relative path → file stamp captured before the
   * execution. Diffing a fresh snapshot against this map detects created and
   * modified files without relying on a wall-clock cutoff, which raced with
   * filesystems that round mtimes down to the second.
   */
  files: Map<string, FileStamp>
}

interface FileStamp {
  mtimeMs: number
  size: number
}

export interface VerificationClaim {
  label: string
  detail: string
  outcome: 'passed' | 'failed' | 'observed'
  provenance: 'tool' | 'user'
}

export interface EvidenceBundle {
  changedFiles: string[]
  newFiles: string[]
  gitDiffSummary?: string
  verification: VerificationClaim[]
  outcome: ExecutionOutcome
}

/** Reads the real workspace before and after an execution; never trusts model claims. */
export class EvidenceCollector {
  async baseline(workspacePath: string): Promise<WorkspaceBaseline> {
    const git = await isGitRepo(workspacePath)
    return {
      git,
      files: git ? new Map() : await snapshotFiles(workspacePath)
    }
  }

  async collect(
    workspacePath: string,
    baseline: WorkspaceBaseline,
    runnerEvents: RunnerEvent[],
    outcome: ExecutionOutcome
  ): Promise<EvidenceBundle> {
    const changedFiles: string[] = []
    const newFiles: string[] = []
    let gitDiffSummary: string | undefined
    if (baseline.git) {
      const status = await git(workspacePath, ['status', '--porcelain'])
      for (const line of (status ?? '').split('\n')) {
        const path = line.slice(3).trim()
        if (!path) continue
        changedFiles.push(path)
        if (line.startsWith('??')) newFiles.push(path)
      }
      const diff = await git(workspacePath, ['diff', '--stat'])
      if (diff?.trim()) gitDiffSummary = diff.trim().slice(0, MAX_DIFF)
    } else {
      for (const file of await changedSince(workspacePath, baseline.files)) {
        changedFiles.push(file)
        if (!baseline.files.has(file)) newFiles.push(file)
      }
    }
    const verification = claimsFromEvents(runnerEvents)
    return {
      changedFiles: dedupe(changedFiles).slice(0, MAX_FILES),
      newFiles: dedupe(newFiles).slice(0, MAX_FILES),
      ...(gitDiffSummary ? { gitDiffSummary } : {}),
      verification,
      outcome
    }
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
    bundle.verification.forEach((claim) => {
      records.push({ id: randomUUID(), kind: 'command', label: claim.label, detail: claim.detail, outcome: claim.outcome, provenance: claim.provenance, observedAt: at(records.length) })
    })
    return records
  }
}

function claimsFromEvents(events: RunnerEvent[]): VerificationClaim[] {
  const claims: VerificationClaim[] = []
  for (const event of events) {
    if (event.kind === 'verification') claims.push({ label: event.message, detail: event.message, outcome: 'passed', provenance: 'tool' })
    else if (event.kind === 'error' && VERIFICATION_LABEL.test(event.message)) claims.push({ label: event.message, detail: event.message, outcome: 'failed', provenance: 'tool' })
  }
  return claims
}

async function isGitRepo(workspacePath: string): Promise<boolean> {
  return (await git(workspacePath, ['rev-parse', '--is-inside-work-tree']))?.trim() === 'true'
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
        found.set(relative(root, full).replace(/\\/g, '/'), { mtimeMs: info.mtimeMs, size: info.size })
      } catch { /* ignore */ }
    }
  }
  return found
}

/** Files that appeared or were touched between the baseline and now. */
async function changedSince(root: string, baseline: Map<string, FileStamp>): Promise<string[]> {
  const now = await snapshotFiles(root)
  const changed: string[] = []
  for (const [file, stamp] of now) {
    const before = baseline.get(file)
    if (before === undefined || before.mtimeMs !== stamp.mtimeMs || before.size !== stamp.size) changed.push(file)
  }
  return changed
}

function dedupe(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))]
}
