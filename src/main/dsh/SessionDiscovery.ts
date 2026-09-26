import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { Readable, Writable } from 'node:stream'
import { realpath } from 'node:fs/promises'
import type { ClientContext, ListSessionsResponse } from '@agentclientprotocol/sdk'

/**
 * Discovery uses the public ACP v1 surface of the shipped `acp` profile
 * (`dsh --profile acp` → `session/list(cwd)`). It never reads DSH private
 * storage and never speaks a private wire protocol.
 *
 * Known ACP behaviour verified against @deepseek-ai/dsh@0.1.7-rc.2:
 * - `session/list` returns persisted, resumable root sessions newest-first.
 * - A session created by `session/new` only becomes listable after it is
 *   persisted (for example by `session/close`), so freshly created sessions
 *   may not appear until their first durable flush.
 * - `nextCursor` drives cursor pagination; the shipped default page size is
 *   100 (`sessionListPageSize`).
 */

export class DshDiscoveryUnavailableError extends Error {
  constructor(capability: 'session discovery' | 'session history') {
    super(`DSH ${capability} is unavailable through the public SDK protocol`)
    this.name = 'DshDiscoveryUnavailableError'
  }
}

/** A discovery attempt failed for a transport/runtime reason, not for absence. */
export class DshDiscoveryError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'DshDiscoveryError'
  }
}

export interface DiscoveredDshSession {
  id: string
  workspacePath: string
  title?: string
  updatedAt?: string
}

export interface SessionDiscoveryOptions {
  /** Absolute path to the built `dsh` CLI module; omitted resolves the installed @deepseek-ai/dsh. */
  dshBin?: string
  /** Bound (ms) on the ACP initialize handshake. */
  initializeTimeoutMs?: number
  /** Bound (ms) on one complete, paginated listing. */
  listTimeoutMs?: number
  /** Safety bound on pagination requests. */
  maxPages?: number
  /** Reuse a recent public session/list result for the same workspace. */
  cacheTtlMs?: number
}

const require = createRequire(__filename)

/** Resolve the built `dsh` CLI entry from the installed public package. */
export function resolveInstalledDshBin(): string {
  const manifest = require.resolve('@deepseek-ai/dsh/package.json')
  return join(dirname(manifest), 'lib', 'bin.js')
}

export class SessionDiscovery {
  private readonly cache = new Map<string, { at: number; sessions: DiscoveredDshSession[] }>()
  private readonly inflight = new Map<string, Promise<DiscoveredDshSession[]>>()

  constructor(private readonly options: SessionDiscoveryOptions = {}) {}

  /**
   * List persisted root sessions whose canonical workspace matches `workspacePath`.
   * The workspace path is canonicalized with `fs.realpath` before the query.
   */
  async listByWorkspace(workspacePath: string): Promise<DiscoveredDshSession[]> {
    const canonical = await canonicalWorkspace(workspacePath)
    const ttl = this.options.cacheTtlMs ?? 30_000
    const cached = this.cache.get(canonical)
    if (cached && Date.now() - cached.at <= ttl) return [...cached.sessions]

    const pending = this.inflight.get(canonical)
    if (pending) return [...await pending]

    const task = this.runAcp(canonical)
      .then((sessions) => {
        this.cache.set(canonical, { at: Date.now(), sessions })
        return sessions
      })
      .finally(() => this.inflight.delete(canonical))
    this.inflight.set(canonical, task)
    return [...await task]
  }

  /** Legacy transcript replay is not part of the public ACP/SDK surface. */
  async readHistory(_sessionId: string): Promise<string> {
    throw new DshDiscoveryUnavailableError('session history')
  }

  private async runAcp(canonicalPath: string): Promise<DiscoveredDshSession[]> {
    const dshBin = this.options.dshBin ?? resolveInstalledDshBin()
    const env: NodeJS.ProcessEnv = { ...process.env }
    // The SDK-backed runtime does the same when it launches from a packaged Electron app.
    if (process.versions.electron) env.ELECTRON_RUN_AS_NODE = '1'

    let child: ChildProcessWithoutNullStreams
    try {
      child = spawn(process.execPath, [dshBin, '--profile', 'acp'], {
        cwd: canonicalPath,
        env,
        stdio: ['pipe', 'pipe', 'pipe']
      })
    } catch (error) {
      throw new DshDiscoveryError(`Failed to launch DSH ACP discovery process: ${messageOf(error)}`, { cause: error })
    }

    let stderr = ''
    child.stderr.on('data', (chunk: Buffer) => {
      // Bounded: only a tail is useful in an error message.
      stderr = (stderr + chunk.toString()).slice(-4096)
    })

    try {
      const acp = await import('@agentclientprotocol/sdk')
      const stream = acp.ndJsonStream(
        Writable.toWeb(child.stdin) as unknown as WritableStream<Uint8Array>,
        Readable.toWeb(child.stdout) as unknown as ReadableStream<Uint8Array>
      )
      const sessions = await withTimeout(
        acp.client({ name: 'temporal-workspace' }).connectWith(stream, async (ctx) => {
          await this.initialize(ctx, acp.PROTOCOL_VERSION)
          return this.paginate(ctx, canonicalPath)
        }),
        this.options.listTimeoutMs ?? 30_000,
        () => child.kill('SIGKILL')
      )
      return dedupeById(sessions)
    } catch (error) {
      if (error instanceof DshDiscoveryError) throw error
      const tail = stderr.trim()
      throw new DshDiscoveryError(
        `DSH ACP session discovery failed: ${messageOf(error)}${tail ? ` (stderr: ${tail})` : ''}`,
        { cause: error }
      )
    } finally {
      // Discovery is read-only and the result is already materialized here.
      // Do not make the UI wait for DSH process teardown: close the transport,
      // terminate the short-lived discovery process, and let Node reap it.
      try { child.stdin.end() } catch { /* already closed */ }
      try { child.stdout.destroy() } catch { /* already closed */ }
      try { child.stderr.destroy() } catch { /* already closed */ }
      if (child.exitCode === null && !child.killed) {
        try { child.kill() } catch { /* already exited */ }
      }
    }
  }

  private async initialize(ctx: ClientContext, protocolVersion: number): Promise<void> {
    const response = await withTimeout(
      ctx.request('initialize', { protocolVersion, clientCapabilities: {} }),
      this.options.initializeTimeoutMs ?? 15_000,
      () => undefined
    )
    if (response.protocolVersion !== protocolVersion) {
      throw new DshDiscoveryError(
        `DSH ACP advertised protocol version ${response.protocolVersion}, expected ${protocolVersion}`
      )
    }
    if (!response.agentCapabilities?.sessionCapabilities?.list) {
      throw new DshDiscoveryError('DSH ACP profile does not advertise the session/list capability')
    }
  }

  private async paginate(ctx: ClientContext, cwd: string): Promise<DiscoveredDshSession[]> {
    const maxPages = this.options.maxPages ?? 100
    const collected: DiscoveredDshSession[] = []
    let cursor: string | null | undefined
    for (let page = 0; page < maxPages; page += 1) {
      const params: { cwd: string; cursor?: string } = { cwd }
      if (cursor) params.cursor = cursor
      const response = await ctx.request('session/list', params) as ListSessionsResponse
      for (const info of response.sessions) {
        collected.push({
          id: info.sessionId,
          workspacePath: info.cwd,
          ...(info.title ? { title: info.title } : {}),
          ...(info.updatedAt ? { updatedAt: info.updatedAt } : {})
        })
      }
      cursor = response.nextCursor ?? undefined
      if (!cursor) return collected
    }
    throw new DshDiscoveryError(`DSH ACP session listing exceeded ${maxPages} pages`)
  }
}

async function canonicalWorkspace(workspacePath: string): Promise<string> {
  try {
    return await realpath(workspacePath)
  } catch (error) {
    throw new DshDiscoveryError(`Workspace directory is not accessible: ${workspacePath}`, { cause: error })
  }
}

function dedupeById(sessions: DiscoveredDshSession[]): DiscoveredDshSession[] {
  const seen = new Map<string, DiscoveredDshSession>()
  for (const session of sessions) {
    if (!seen.has(session.id)) seen.set(session.id, session)
  }
  return [...seen.values()]
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    timer.unref?.()
  })
}

async function withTimeout<T>(promise: Promise<T>, ms: number, onTimeout: () => void): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      try { onTimeout() } catch { /* ignore */ }
      reject(new DshDiscoveryError(`DSH ACP discovery timed out after ${ms}ms`))
    }, ms)
    timer.unref?.()
  })
  try {
    return await Promise.race([promise, timeout])
  } finally {
    if (timer) clearTimeout(timer)
  }
}
