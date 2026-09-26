import { randomUUID } from 'node:crypto'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable, Writable } from 'node:stream'
import type { ClientConnection, RequestPermissionRequest, SessionNotification } from '@agentclientprotocol/sdk'
import type { ModelSettings, PermissionPreset, RunnerEvent } from '../../shared/contracts'
import type { ToolCallFact } from '../evidence/evidence'
import { resolveInstalledDshBin } from './SessionDiscovery'
import { TurnProjector, type ProjectedEvent } from './projection'
import { windowsConsolePreloadSource } from './WindowsRuntimeHost'

/** Thrown when a prompt turn hits its deadline: the turn was cancelled via
 *  the public `session/cancel` notification (or abandoned after a grace
 *  period when even that did not settle). Consumers must treat this as a
 *  deadline termination, not a generic runtime error. */
export const TURN_DEADLINE_MESSAGE = 'DSH turn deadline exceeded (cancelled via session/cancel)'
export const TURN_CANCELLED_MESSAGE = 'DSH turn cancelled by user'
const TURN_CANCEL_GRACE_MS = 8_000

export interface DshRuntimeOptions {
  workspacePath: string
  settings: ModelSettings
  credential?: string
  /** Session-level sandbox preset; enforced by DSH via DSH_PERMISSION_MODE. */
  permission?: PermissionPreset
  onEvent?: (event: RunnerEvent) => void
  /** High-detail per-session diagnostics used to analyze slow runs. */
  onDebug?: (type: string, payload?: unknown) => void
  /** Absolute path to the built `dsh` CLI module; omitted resolves the installed @deepseek-ai/dsh. */
  dshBin?: string
  /** Optional bound (ms) on one prompt turn. 0 disables the bound (long-running turns). */
  requestTimeoutMs?: number
}

/**
 * One window's execution path for one DSH Session, driven entirely by the
 * public ACP profile (`dsh --profile acp`).
 *
 * The SDK `sdk` profile cannot resume a persisted session (its server always
 * calls `agents.create`; see docs/dsh-upstream-resume-report.md), so execution
 * uses ACP directly: `session/new` for a fresh session and `session/resume`
 * for a persisted one, then `session/prompt` for each turn. This keeps new and
 * resumed sessions on one public transport and preserves context across
 * runtime restarts without replaying text into the prompt.
 */
export class DshRuntime {
  private child?: ChildProcessWithoutNullStreams
  private connection?: ClientConnection
  private sessionId?: string
  private busy = false
  private cancelRequested = false
  private closed = false
  private projector?: TurnProjector
  private turnToolFacts: ToolCallFact[] = []
  private patchDir?: string
  private stderr = ''
  private protocolVersion = 1
  private promptSequence = 0

  constructor(private readonly options: DshRuntimeOptions) {}

  async start(sessionId?: string): Promise<{ sessionId: string }> {
    if (this.closed) throw new Error('DSH runtime has been closed')
    if (this.sessionId !== undefined) {
      if (sessionId !== undefined && sessionId !== this.sessionId) {
        throw new Error('A DSH runtime can own only one session')
      }
      return { sessionId: this.sessionId }
    }
    const provider = this.options.settings.provider.trim()
    const model = this.options.settings.model.trim()
    this.debug('runtime.start.begin', { provider, model, workspacePath: this.options.workspacePath, resumeSessionId: sessionId })
    const baseUrl = this.options.settings.baseUrl?.trim()
    if (!provider || !model) throw new Error('Configure a model provider and model before starting DSH')
    const official = provider === 'deepseek-official'
    if (!official && !baseUrl) {
      throw new Error(`Provider "${provider}" needs an OpenAI-compatible Base URL`)
    }

    const acp = await import('@agentclientprotocol/sdk')
    this.protocolVersion = acp.PROTOCOL_VERSION
    const dshBin = this.options.dshBin ?? resolveInstalledDshBin()
    this.patchDir = await mkdtemp(join(tmpdir(), 'temporal-acp-run-'))
    const patchPath = join(this.patchDir, 'profile.patch.yml')
    await writeFile(patchPath, providerPatch({ provider, model, baseUrl: baseUrl ?? '', official }))

    const env: NodeJS.ProcessEnv = { ...process.env }
    if (process.platform === 'win32' && process.versions.electron) {
      const preload = join(this.patchDir, 'console-preload.cjs')
      await writeFile(preload, windowsConsolePreloadSource(require.resolve('koffi')))
      // Runner processes also use the GUI Electron executable. A scoped Node
      // preload reaches those descendants; ordinary project node.exe processes
      // return without loading native bindings or changing their console.
      env.NODE_OPTIONS = `${env.NODE_OPTIONS ?? ''} --require ${JSON.stringify(preload.replace(/\\/g, '/'))}`.trim()
    }
    if (process.versions.electron) env.ELECTRON_RUN_AS_NODE = '1'
    if (this.options.credential) {
      // deepseek-official reads DEEPSEEK_API_KEY; any other provider is mounted
      // as a hand-declared pi-ai OpenAI-compatible route using this env name.
      if (official) env.DEEPSEEK_API_KEY = this.options.credential
      else env.TEMPORAL_LLM_API_KEY = this.options.credential
    }
    if (baseUrl && official) env.DEEPSEEK_BASE_URL = baseUrl
    if (this.options.permission) env.DSH_PERMISSION_MODE = this.options.permission

    let child: ChildProcessWithoutNullStreams
    try {
      child = spawn(process.execPath, [dshBin, '--profile', 'acp', '--patch', patchPath], {
        cwd: this.options.workspacePath,
        env,
        stdio: ['pipe', 'pipe', 'pipe']
      })
    } catch (error) {
      await this.cleanupPatch()
      throw new Error(`Failed to launch DSH ACP runtime: ${messageOf(error)}`)
    }
    this.child = child
    this.debug('runtime.process.spawned', { pid: child.pid, dshBin, patchPath })
    child.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString()
      this.stderr = (this.stderr + text).slice(-4096)
      this.debug('runtime.stderr', { text })
    })

    try {
      const app = acp.client({ name: 'temporal-workspace' })
        .onNotification('session/update', ({ params }) => this.onUpdate(params))
        .onRequest('session/request_permission', ({ params }) => this.onPermission(params))
      this.connection = app.connect(acp.ndJsonStream(
        Writable.toWeb(child.stdin) as unknown as WritableStream<Uint8Array>,
        Readable.toWeb(child.stdout) as unknown as ReadableStream<Uint8Array>
      ))
      this.debug('acp.initialize.start', { protocolVersion: this.protocolVersion })
      await this.connection.agent.request('initialize', {
        protocolVersion: this.protocolVersion,
        clientCapabilities: {}
      })
      this.debug('acp.initialize.end', { protocolVersion: this.protocolVersion })
      const cwd = this.options.workspacePath
      if (sessionId) {
        this.debug('acp.session.resume.start', { sessionId, cwd })
        await this.connection.agent.request('session/resume', { sessionId, cwd, mcpServers: [] })
        this.sessionId = sessionId
        this.debug('acp.session.resume.end', { sessionId, cwd })
      } else {
        this.debug('acp.session.new.start', { cwd })
        const created = await this.connection.agent.request('session/new', { cwd, mcpServers: [] })
        this.sessionId = created.sessionId
        this.debug('acp.session.new.end', { sessionId: created.sessionId, cwd })
      }
      this.debug('runtime.start.end', { sessionId: this.sessionId })
      return { sessionId: this.sessionId }
    } catch (error) {
      await this.close()
      const tail = this.stderr.trim()
      throw new Error(`DSH ACP start failed: ${messageOf(error)}${tail ? ` (stderr: ${tail})` : ''}`)
    }
  }

  async prompt(spec: string, opts?: { timeoutMs?: number }): Promise<{ text: string }> {
    if (this.closed) throw new Error('DSH runtime has been closed')
    if (!spec.trim()) throw new Error('Spec must not be empty')
    if (this.busy) throw new Error('DSH session is already running')
    const sessionId = this.sessionId
    const connection = this.connection
    if (!sessionId || !connection) throw new Error('Start the DSH runtime before submitting a Spec')

    this.busy = true
    this.cancelRequested = false
    const promptSequence = ++this.promptSequence
    const promptStartedAt = Date.now()
    const projector = new TurnProjector()
    this.projector = projector
    this.turnToolFacts = []
    const controller = new AbortController()
    const timeoutMs = opts?.timeoutMs ?? this.options.requestTimeoutMs ?? 0
    this.debug('prompt.start', { promptSequence, timeoutMs, chars: spec.length, text: spec })
    let deadlineHit = false
    const timer = timeoutMs > 0
      ? setTimeout(() => {
          deadlineHit = true
          controller.abort()
          // Public ACP cancellation: the agent stops the turn, so the pending
          // session/prompt settles instead of keeping the resources busy.
          void this.cancelTurn()
        }, timeoutMs)
      : undefined
    try {
      const request = connection.agent.request(
        'session/prompt',
        { sessionId, prompt: [{ type: 'text', text: spec }] },
        timeoutMs > 0 ? { cancellationSignal: controller.signal } : undefined
      )
      const result = timeoutMs > 0
        ? await Promise.race([
            request,
            delay(timeoutMs + TURN_CANCEL_GRACE_MS).then(() => null)
          ])
        : await request
      if (deadlineHit || result === null) {
        // A deadline may either have been cancelled by the agent (result) or,
        // when even the cancel did not settle the request in time, rejected
        // here after the grace period. Both are deadline terminations.
        throw new Error(TURN_DEADLINE_MESSAGE)
      }
      if (this.cancelRequested) throw new Error(TURN_CANCELLED_MESSAGE)
      this.debug('prompt.response', { promptSequence, durationMs: Date.now() - promptStartedAt, assistantChars: projector.assistantText.length })
      return { text: projector.assistantText }
    } catch (error) {
      if (deadlineHit) {
        this.debug('prompt.error', { promptSequence, durationMs: Date.now() - promptStartedAt, error: TURN_DEADLINE_MESSAGE })
        this.emit({ kind: 'error', message: TURN_DEADLINE_MESSAGE })
        throw new Error(TURN_DEADLINE_MESSAGE)
      }
      if (this.cancelRequested || messageOf(error) === TURN_CANCELLED_MESSAGE) {
        this.debug('prompt.error', { promptSequence, durationMs: Date.now() - promptStartedAt, error: TURN_CANCELLED_MESSAGE })
        this.emit({ kind: 'status', message: 'run cancelled by user' })
        throw new Error(TURN_CANCELLED_MESSAGE)
      }
      this.debug('prompt.error', { promptSequence, durationMs: Date.now() - promptStartedAt, error: messageOf(error) })
      this.emit({ kind: 'error', message: messageOf(error) })
      throw error
    } finally {
      if (timer) clearTimeout(timer)
      // Tool-call updates for one ACP call arrive incrementally. Keep the
      // projector's map alive for the whole turn so later updates can upgrade
      // pending facts to completed/failed before we expose the final snapshot.
      this.turnToolFacts = projector.drainToolFacts()
      this.debug('prompt.finalize', { promptSequence, durationMs: Date.now() - promptStartedAt, toolFacts: this.turnToolFacts, assistantChars: projector.assistantText.length })
      this.projector = undefined
      this.busy = false
      this.cancelRequested = false
    }
  }

  /** Ask the agent to stop the current turn through the public ACP
   *  `session/cancel` notification. Resolves false when no turn is active or
   *  the notification could not be delivered. */
  async cancelTurn(): Promise<boolean> {
    const connection = this.connection
    const sessionId = this.sessionId
    if (!connection || !sessionId || this.closed || !this.busy) return false
    this.cancelRequested = true
    this.debug('acp.session.cancel.start', { sessionId })
    try {
      await connection.agent.notify('session/cancel', { sessionId })
      this.debug('acp.session.cancel.sent', { sessionId })
      return true
    } catch (error) {
      this.cancelRequested = false
      this.debug('acp.session.cancel.error', { sessionId, error: messageOf(error) })
      return false
    }
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.debug('runtime.close.begin', { sessionId: this.sessionId, busy: this.busy })
    const connection = this.connection
    const sessionId = this.sessionId
    this.connection = undefined
    this.sessionId = undefined
    this.projector = undefined
    if (connection && sessionId) {
      try {
        // Bounded: a wedged agent must not keep the window's teardown waiting.
        await Promise.race([
          connection.agent.request('session/close', { sessionId }),
          delay(3_000)
        ])
      } catch { /* the runtime may already be gone */ }
    }
    connection?.close()
    const child = this.child
    this.child = undefined
    if (child) {
      try { child.stdin.end() } catch { /* already closed */ }
      const exited = new Promise<void>((resolve) => { child.once('exit', () => resolve()); child.once('error', () => resolve()) })
      const reaped = await Promise.race([exited.then(() => true), delay(8_000).then(() => false)])
      if (!reaped) child.kill('SIGKILL')
    }
    await this.cleanupPatch()
    this.debug('runtime.close.end', { sessionId })
  }

  private onUpdate(notification: SessionNotification): void {
    const projector = this.projector
    if (!projector) return
    if (notification.sessionId !== this.sessionId) return
    this.debug('acp.session.update', { sessionId: notification.sessionId, update: notification.update })
    projector.handle(notification.update)
    for (const event of projector.drain()) this.emit(event)
  }

  /** Returns and clears the structured tool facts for the most recent turn. */
  takeToolFacts(): ToolCallFact[] {
    const facts = this.turnToolFacts
    this.turnToolFacts = []
    return facts
  }

  /**
   * Honour the session's permission preset instead of blindly approving.
   * DSH enforces the sandbox, but it still asks the client for approval on
   * operations that cross the mode's boundary (notably shell commands). A
   * `read-only` session may only approve read-only tool kinds; anything that
   * could modify the workspace is rejected, so the preset cannot be escalated
   * by the client. `workspace-write` and `danger-full-access` approve, leaving
   * the workspace boundary to DSH's sandbox.
   */
  private onPermission(params: RequestPermissionRequest): { outcome: { outcome: 'selected'; optionId: string } } | { outcome: { outcome: 'cancelled' } } {
    this.debug('acp.permission.request', params)
    const options = params.options ?? []
    const allow = options.find((option) => option.kind === 'allow_once') ?? options.find((option) => option.kind === 'allow_always')
    const reject = options.find((option) => option.kind === 'reject_once') ?? options.find((option) => option.kind === 'reject_always')
    const kind = params.toolCall?.kind ?? 'other'
    const allowedKinds = new Set(['read', 'search', 'think', 'fetch'])
    const permitted = this.options.permission !== 'read-only' || allowedKinds.has(kind)
    if (permitted && allow) {
      this.emit({ kind: 'status', message: `permission granted (${kind})` })
      this.debug('acp.permission.decision', { kind, decision: 'allow', optionId: allow.optionId })
      return { outcome: { outcome: 'selected', optionId: allow.optionId } }
    }
    if (!permitted && reject) {
      this.emit({ kind: 'status', message: `permission denied by read-only (${kind})` })
      this.debug('acp.permission.decision', { kind, decision: 'reject', optionId: reject.optionId })
      return { outcome: { outcome: 'selected', optionId: reject.optionId } }
    }
    this.emit({ kind: 'error', message: `DSH permission request had no ${permitted ? 'allow' : 'reject'} option (${kind})` })
    return { outcome: { outcome: 'cancelled' } }
  }

  private emit(event: ProjectedEvent): void {
    this.options.onEvent?.({ id: randomUUID(), at: new Date().toISOString(), kind: event.kind, message: event.message })
  }

  private debug(type: string, payload?: unknown): void {
    this.options.onDebug?.(type, payload)
  }

  private async cleanupPatch(): Promise<void> {
    const dir = this.patchDir
    this.patchDir = undefined
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}

function yamlScalar(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

/**
 * Builds the DSH patch that selects `provider`/`model` for the ACP profile.
 * `deepseek-official` uses the shipped DeepSeek route. Any other provider is
 * mounted as a hand-declared `@deepseek-ai/dsh-llm-pi-ai` OpenAI-compatible
 * route pointing at `baseUrl`, so gateways like Volcengine ARK are pure config.
 */
function providerPatch(input: { provider: string; model: string; baseUrl: string; official: boolean }): string {
  const acp = `- id: acp\n  config:\n    provider: ${yamlScalar(input.provider)}\n    model: ${yamlScalar(input.model)}\n`
  if (input.official) return acp
  return [
    '- id: llm-pi-ai',
    '  config:',
    '    providers:',
    `      ${yamlScalar(input.provider)}:`,
    `        displayName: ${yamlScalar(input.provider)}`,
    '        apiKeyEnv: TEMPORAL_LLM_API_KEY',
    '        api: openai-completions',
    `        baseURL: ${yamlScalar(input.baseUrl)}`,
    '        models:',
    `          - id: ${yamlScalar(input.model)}`,
    `            name: ${yamlScalar(input.model)}`,
    '            contextWindow: 131072',
    '            maxTokens: 32768',
    acp.trimEnd()
  ].join('\n') + '\n'
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
