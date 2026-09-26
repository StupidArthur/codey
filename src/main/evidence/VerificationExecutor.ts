import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { readFile, realpath, stat } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { CheckFact, CheckMethod } from './evidence'
import type { FileStateMap, VerificationRequest, VerificationRun } from './evidence'

const MAX_OUTPUT = 2_000
const DEFAULT_TIMEOUT_MS = 120_000
/** Content hashes are computed for files up to this size (stamps + content checks). */
const HASH_CAP_BYTES = 1_000_000

type ShellMethod = Extract<CheckMethod, { kind: 'shell' }>
type BuiltinMethod = Exclude<CheckMethod, { kind: 'shell' }>

/**
 * The product's own workspace verification executor — the only source of
 * `passed`/`failed` verdicts. It runs under the session's permission:
 *
 * - Built-in checks (file existence, content equality, config field) are
 *   path-constrained read-only APIs. They never spawn a process and never
 *   write; targets must resolve inside the canonical workspace (lexical
 *   escapes, other drives, UNC paths, junctions and symlinks are resolved and
 *   rejected).
 * - Shell checks execute arbitrary commands and therefore cannot be confined
 *   on Windows. They are refused (fail closed) unless the session preset is
 *   explicitly `danger-full-access`; a missing preset is always refused.
 *   Refusals are recorded as `denied` with the real reason — never as a pass,
 *   and never silently upgraded to a more permissive preset.
 */
export class VerificationExecutor {
  /** Arrow field so the executor can be passed as a bare callback
   *  (`deps.verify = executor.run`) without losing its `this`. */
  run = async (request: VerificationRequest): Promise<VerificationRun> => {
    const at = new Date().toISOString()
    const preset = request.permission?.preset
    if (!preset) {
      return this.denied(request, at, 'no session permission preset was provided; refusing to execute verification (fail closed)')
    }
    if (request.method.kind === 'shell') {
      if (preset !== 'danger-full-access') {
        return this.denied(
          request, at,
          `shell verification is not executed under the '${preset}' session permission: arbitrary commands cannot be ` +
          'confined to the workspace on this platform, so they are refused instead of bypassing the boundary. ' +
          'Make the requirement verifiable by built-in read-only checks, or run the session with explicit full-access permission.'
        )
      }
      return this.runShell(request, request.method, at)
    }
    return this.runBuiltin(request, request.method, at)
  }

  private denied(request: VerificationRequest, at: string, reason: string): VerificationRun {
    return {
      id: randomUUID(),
      turn: request.turn,
      label: request.label,
      method: request.method.kind === 'shell' ? 'shell' : 'builtin',
      command: describeMethod(request.method),
      exitCode: null,
      signal: null,
      outputTail: '',
      scope: request.scope,
      targets: request.targets,
      facts: [],
      stamps: new Map(),
      outcome: 'denied',
      denial: reason,
      at
    }
  }

  private async runBuiltin(request: VerificationRequest, method: BuiltinMethod, at: string): Promise<VerificationRun> {
    const workspacePath = request.permission!.workspacePath
    const target = method.target
    const stamps: FileStateMap = new Map()
    let fact: CheckFact
    let outputTail = ''

    const contained = await resolveInsideWorkspace(workspacePath, target)
    if (!contained) {
      fact = deniedFact(method, target)
      outputTail = `target '${target}' does not resolve inside the workspace; the check was refused`
      const denial = `builtin check refused: target '${target}' escapes the workspace boundary`
      return this.finish(request, at, 'builtin', describeMethod(method), 'denied', [fact], stamps, null, null, outputTail, denial)
    }

    if (method.kind === 'file-exists') {
      const info = await statSafe(contained)
      const isFile = info.exists && info.isFile
      fact = { kind: 'file-exists', target, isFile, matched: isFile }
      if (info.exists && !isFile) outputTail = `target '${target}' exists but is not a regular file`
      else if (!info.exists) outputTail = `target '${target}' does not exist`
    } else if (method.kind === 'content-equals') {
      const expectedHash = sha1Text(method.expected)
      let actualText: string | null = null
      let actualHash: string | null = null
      const info = await statSafe(contained)
      if (!info.exists) {
        outputTail = `target '${target}' does not exist`
      } else if (!info.isFile) {
        outputTail = `target '${target}' is not a regular file`
      } else if (info.size > HASH_CAP_BYTES) {
        outputTail = `target '${target}' is too large to verify by content (${info.size} bytes)`
      } else {
        try {
          actualText = (await readFile(contained, 'utf8')).replace(/\r\n/g, '\n')
          actualHash = sha1Text(actualText)
        } catch (error) {
          outputTail = `target '${target}' could not be read: ${String((error as Error)?.message ?? error).slice(0, 200)}`
        }
      }
      const matched = actualText !== null && normalize(actualText) === normalize(method.expected)
      fact = { kind: 'content-equals', target, expectedHash, actualHash, matched }
      if (!matched && actualText !== null) {
        outputTail = outputTail || `content mismatch: expected ${truncateText(method.expected, 120)}, actual ${truncateText(actualText, 120)}`
      }
    } else {
      // field-equals: parse a JSON document and compare one field.
      let actual: string | null = null
      const info = await statSafe(contained)
      if (!info.exists) {
        outputTail = `target '${target}' does not exist`
      } else if (!target.toLowerCase().endsWith('.json')) {
        outputTail = `field checks require a .json document; '${target}' has no supported parser`
      } else if (info.size > HASH_CAP_BYTES) {
        outputTail = `target '${target}' is too large to parse (${info.size} bytes)`
      } else {
        try {
          const parsed: unknown = JSON.parse(await readFile(contained, 'utf8'))
          const value = readField(parsed, method.key)
          actual = value === undefined ? null : String(value)
        } catch (error) {
          outputTail = `target '${target}' is not valid JSON: ${String((error as Error)?.message ?? error).slice(0, 200)}`
        }
      }
      const matched = actual !== null && actual === method.expected
      fact = { kind: 'field-equals', target, key: method.key, expected: method.expected, actual, matched }
      if (!matched && outputTail === '') {
        outputTail = actual === null
          ? `field '${method.key}' is missing in '${target}'`
          : `field '${method.key}' is '${actual}', expected '${method.expected}'`
      }
    }

    // Stamp the target (with content hash) whether the check passed or failed,
    // so a later modification can invalidate the recorded fact.
    stamps.set(target, await stampFile(contained))
    const outcome = fact.matched ? 'passed' : 'failed'
    return this.finish(request, at, 'builtin', describeMethod(method), outcome, [fact], stamps, null, null, outputTail)
  }

  private async runShell(request: VerificationRequest, method: ShellMethod, at: string): Promise<VerificationRun> {
    const timeoutMs = request.timeoutMs ?? DEFAULT_TIMEOUT_MS
    const command = sanitizeCommandLine(method.command, method.args)
    const stamps: FileStateMap = new Map()
    for (const target of request.targets) {
      const contained = await resolveInsideWorkspace(request.permission!.workspacePath, target)
      if (contained) stamps.set(target, await stampFile(contained))
    }
    const result = await runProcess(method.command, method.args, request.cwd, timeoutMs)
    const fact: CheckFact = { kind: 'command-exit', command, exitCode: result.exitCode, matched: result.exitCode === 0 }
    const outcome = result.exitCode === 0 ? 'passed' : result.exitCode === null ? 'observed' : 'failed'
    return this.finish(request, at, 'shell', command, outcome, [fact], stamps, result.exitCode, result.signal, result.outputTail)
  }

  private finish(
    request: VerificationRequest,
    at: string,
    method: 'builtin' | 'shell',
    command: string,
    outcome: VerificationRun['outcome'],
    facts: CheckFact[],
    stamps: FileStateMap,
    exitCode: number | null,
    signal: string | null,
    outputTail: string,
    denial?: string
  ): VerificationRun {
    return {
      id: randomUUID(),
      turn: request.turn,
      label: request.label,
      method,
      command,
      exitCode,
      signal,
      outputTail: outputTail.slice(0, MAX_OUTPUT),
      scope: request.scope,
      targets: request.targets,
      facts,
      stamps,
      outcome,
      ...(denial ? { denial } : {}),
      at
    }
  }
}

function deniedFact(method: BuiltinMethod, target: string): CheckFact {
  if (method.kind === 'file-exists') return { kind: 'file-exists', target, isFile: false, matched: false }
  if (method.kind === 'content-equals') return { kind: 'content-equals', target, expectedHash: sha1Text(method.expected), actualHash: null, matched: false }
  return { kind: 'field-equals', target, key: method.key, expected: method.expected, actual: null, matched: false }
}

export function describeMethod(method: VerificationRequest['method']): string {
  switch (method.kind) {
    case 'file-exists': return `builtin:file-exists ${method.target}`
    case 'content-equals': return `builtin:content-equals ${method.target}`
    case 'field-equals': return `builtin:field-equals ${method.target}#${method.key}`
    case 'shell': return sanitizeCommandLine(method.command, method.args)
  }
}

/**
 * Resolve a workspace-relative (or workspace-absolute) target to an absolute
 * path that is provably inside the canonical workspace. Handles `..`, absolute
 * paths, other drive letters, UNC paths, and junction/symlink re-entry points:
 * the longest existing prefix is resolved through realpath and the result must
 * stay inside the workspace (case-insensitively on Windows).
 */
async function resolveInsideWorkspace(workspacePath: string, target: string): Promise<string | null> {
  const workspace = resolve(workspacePath)
  if (!target || target.includes('\0')) return null
  const nativeTarget = sep === '\\' ? target.replace(/\//g, '\\') : target
  const candidate = resolve(workspace, nativeTarget)
  if (!lexicallyInside(workspace, candidate)) return null
  const rel = relative(workspace, candidate)
  const segments = rel.split(sep)
  for (let cut = segments.length; cut >= 0; cut -= 1) {
    const prefix = cut === 0 ? workspace : join(workspace, ...segments.slice(0, cut))
    const real = await realpathSafe(prefix)
    if (!real) continue
    const suffix = segments.slice(cut)
    const resolved = suffix.length === 0 ? real : join(real, ...suffix)
    const workspaceReal = (await realpathSafe(workspace)) ?? workspace
    if (!lexicallyInside(workspace, resolved) || !lexicallyInside(workspaceReal, resolved)) return null
    return resolved
  }
  return null
}

function lexicallyInside(workspace: string, candidate: string): boolean {
  const rel = relative(workspace, candidate)
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return false
  if (sep === '\\') {
    const lowerWorkspace = workspace.toLowerCase()
    const lowerCandidate = candidate.toLowerCase()
    return lowerCandidate === lowerWorkspace || lowerCandidate.startsWith(`${lowerWorkspace}\\`)
  }
  return candidate.startsWith(`${workspace}${sep}`)
}

async function realpathSafe(path: string): Promise<string | null> {
  try {
    return await realpath(path)
  } catch {
    return null
  }
}

interface StatInfo {
  exists: boolean
  isFile: boolean
  size: number
  mtimeMs: number
}

async function statSafe(path: string): Promise<StatInfo> {
  try {
    const info = await stat(path)
    return { exists: true, isFile: info.isFile(), size: info.size, mtimeMs: info.mtimeMs }
  } catch {
    return { exists: false, isFile: false, size: 0, mtimeMs: 0 }
  }
}

/** File stamp including a bounded content hash for same-size/same-mtime detection. */
async function stampFile(path: string): Promise<{ exists: boolean; mtimeMs: number; size: number; hash?: string }> {
  const info = await statSafe(path)
  if (!info.exists || !info.isFile) return { exists: false, mtimeMs: 0, size: 0 }
  const hash = info.size <= HASH_CAP_BYTES ? await hashFile(path) : undefined
  return { exists: true, mtimeMs: info.mtimeMs, size: info.size, ...(hash ? { hash } : {}) }
}

async function hashFile(path: string): Promise<string | undefined> {
  try {
    return createHash('sha1').update(await readFile(path)).digest('hex')
  } catch {
    return undefined
  }
}

function sha1Text(text: string): string {
  return createHash('sha1').update(text, 'utf8').digest('hex')
}

/** Content comparison ignores line-ending style and trailing whitespace. */
function normalize(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/\s+$/, '')
}

function readField(parsed: unknown, key: string): unknown {
  let current: unknown = parsed
  for (const segment of key.split('.')) {
    if (current === null || typeof current !== 'object') return undefined
    current = (current as Record<string, unknown>)[segment]
  }
  return current
}

function truncateText(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${JSON.stringify(`${flat.slice(0, max - 1)}…`)} (${flat.length} chars)` : JSON.stringify(flat)
}

interface ProcessResult {
  exitCode: number | null
  signal: string | null
  outputTail: string
}

function runProcess(command: string, args: string[], cwd: string, timeoutMs: number): Promise<ProcessResult> {
  return new Promise((resolvePromise) => {
    let output = ''
    let settled = false
    let child: ReturnType<typeof spawn> | undefined
    try {
      // `cmd /c` parses its own remainder, so let it see the exact string:
      // without windowsVerbatimArguments Node quotes the whole command, which
      // breaks commands that carry their own quoting inside the /c string.
      child = spawn(command, args, { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], ...(command === 'cmd' ? { windowsVerbatimArguments: true } : {}) })
    } catch (error) {
      resolvePromise({ exitCode: null, signal: null, outputTail: String((error as Error)?.message ?? error).slice(0, MAX_OUTPUT) })
      return
    }
    const append = (chunk: Buffer): void => {
      output = (output + chunk.toString()).slice(-MAX_OUTPUT)
    }
    child.stdout?.on('data', append)
    child.stderr?.on('data', append)
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      void killProcessTree(child).then(() => {
        resolvePromise({ exitCode: null, signal: 'timeout', outputTail: output.trim().slice(-MAX_OUTPUT) })
      })
    }, timeoutMs)
    child.on('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolvePromise({ exitCode: null, signal: null, outputTail: String(error.message).slice(0, MAX_OUTPUT) })
    })
    child.on('close', (code, signal) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolvePromise({ exitCode: code, signal: signal ?? null, outputTail: output.trim().slice(-MAX_OUTPUT) })
    })
  })
}

/** Terminate the whole verification process tree; a bare kill could leave
 *  grandchildren running (and writing) after the timeout. taskkill /T must run
 *  BEFORE the direct kill: once the parent is gone its tree is unresolvable. */
async function killProcessTree(child: NonNullable<ReturnType<typeof spawn>>): Promise<void> {
  const pid = child.pid
  if (pid && process.platform === 'win32') {
    await new Promise<void>((resolvePromise) => {
      const killer = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
      killer.on('error', () => resolvePromise())
      killer.on('close', () => resolvePromise())
      setTimeout(resolvePromise, 5_000)
    })
  }
  try { child.kill('SIGKILL') } catch { /* gone */ }
}

function sanitizeCommandLine(command: string, args: string[]): string {
  const joined = [command, ...args].join(' ')
  return joined.replace(/\s+/g, ' ').trim().slice(0, 500)
}
