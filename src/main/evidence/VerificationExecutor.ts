import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { stat } from 'node:fs/promises'
import { join, sep } from 'node:path'
import type { FileStateMap, VerificationRequest, VerificationRun } from './evidence'

const MAX_OUTPUT = 2_000
const DEFAULT_TIMEOUT_MS = 120_000

/**
 * The product's own workspace verification executor. This is the only source
 * of `passed`/`failed` verification verdicts: it spawns the requested check in
 * the workspace and records the real exit code, output tail and the file states
 * of its targets at run time (so a later modification can invalidate it).
 */
export class VerificationExecutor {
  async run(request: VerificationRequest): Promise<VerificationRun> {
    const stamps: FileStateMap = new Map()
    for (const target of request.targets) {
      stamps.set(target, await fileState(join(request.cwd, toNativePath(target))))
    }
    const at = new Date().toISOString()
    const timeoutMs = request.timeoutMs ?? DEFAULT_TIMEOUT_MS
    const command = sanitizeCommandLine(request.command, request.args)
    const result = await runProcess(request.command, request.args, request.cwd, timeoutMs)
    const outcome = result.exitCode === 0 ? 'passed' : result.exitCode === null ? 'observed' : 'failed'
    return {
      id: randomUUID(),
      turn: request.turn,
      label: request.label,
      command,
      exitCode: result.exitCode,
      signal: result.signal,
      outputTail: result.outputTail,
      scope: request.scope,
      targets: request.targets,
      covers: request.covers,
      stamps,
      outcome,
      at
    }
  }
}

interface ProcessResult {
  exitCode: number | null
  signal: string | null
  outputTail: string
}

function runProcess(command: string, args: string[], cwd: string, timeoutMs: number): Promise<ProcessResult> {
  return new Promise((resolve) => {
    let output = ''
    let settled = false
    let child: ReturnType<typeof spawn> | undefined
    try {
      // `cmd /c` parses its own remainder, so let it see the exact string:
      // without windowsVerbatimArguments Node quotes the whole command, which
      // breaks `if exist "path with spaces" (…)` inside the /c string.
      child = spawn(command, args, { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], ...(command === 'cmd' ? { windowsVerbatimArguments: true } : {}) })
    } catch (error) {
      resolve({ exitCode: null, signal: null, outputTail: String((error as Error)?.message ?? error).slice(0, MAX_OUTPUT) })
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
      try { child?.kill('SIGKILL') } catch { /* gone */ }
      resolve({ exitCode: null, signal: 'timeout', outputTail: output.trim().slice(-MAX_OUTPUT) })
    }, timeoutMs)
    child.on('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ exitCode: null, signal: null, outputTail: String(error.message).slice(0, MAX_OUTPUT) })
    })
    child.on('close', (code, signal) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ exitCode: code, signal: signal ?? null, outputTail: output.trim().slice(-MAX_OUTPUT) })
    })
  })
}

async function fileState(path: string): Promise<{ exists: boolean; mtimeMs: number; size: number }> {
  try {
    const info = await stat(path)
    return { exists: true, mtimeMs: info.mtimeMs, size: info.size }
  } catch {
    return { exists: false, mtimeMs: 0, size: 0 }
  }
}

function toNativePath(relativePath: string): string {
  return sep === '\\' ? relativePath.replace(/\//g, '\\') : relativePath
}

function sanitizeCommandLine(command: string, args: string[]): string {
  const joined = [command, ...args].join(' ')
  return joined.replace(/\s+/g, ' ').trim().slice(0, 500)
}
