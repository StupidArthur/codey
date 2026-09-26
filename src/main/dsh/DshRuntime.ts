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

export interface DshRuntimeOptions {
  workspacePath: string
  settings: ModelSettings
  credential?: string
  /** Session-level sandbox preset; enforced by DSH via DSH_PERMISSION_MODE. */
  permission?: PermissionPreset
  onEvent?: (event: RunnerEvent) => void
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
  private closed = false
  private projector?: TurnProjector
  private turnToolFacts: ToolCallFact[] = []
  private patchDir?: string
  private stderr = ''
  private protocolVersion = 1

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
    child.stderr.on('data', (chunk: Buffer) => {
      this.stderr = (this.stderr + chunk.toString()).slice(-4096)
    })

    try {
      const app = acp.client({ name: 'temporal-workspace' })
        .onNotification('session/update', ({ params }) => this.onUpdate(params))
        .onRequest('session/request_permission', ({ params }) => this.onPermission(params))
      this.connection = app.connect(acp.ndJsonStream(
        Writable.toWeb(child.stdin) as unknown as WritableStream<Uint8Array>,
        Readable.toWeb(child.stdout) as unknown as ReadableStream<Uint8Array>
      ))
      await this.connection.agent.request('initialize', {
        protocolVersion: this.protocolVersion,
        clientCapabilities: {}
      })
      const cwd = this.options.workspacePath
      if (sessionId) {
        await this.connection.agent.request('session/resume', { sessionId, cwd, mcpServers: [] })
        this.sessionId = sessionId
      } else {
        const created = await this.connection.agent.request('session/new', { cwd, mcpServers: [] })
        this.sessionId = created.sessionId
      }
      return { sessionId: this.sessionId }
    } catch (error) {
      await this.close()
      const tail = this.stderr.trim()
      throw new Error(`DSH ACP start failed: ${messageOf(error)}${tail ? ` (stderr: ${tail})` : ''}`)
    }
  }

  async prompt(spec: string): Promise<{ text: string }> {
    if (this.closed) throw new Error('DSH runtime has been closed')
    if (!spec.trim()) throw new Error('Spec must not be empty')
    if (this.busy) throw new Error('DSH session is already running')
    const sessionId = this.sessionId
    const connection = this.connection
    if (!sessionId || !connection) throw new Error('Start the DSH runtime before submitting a Spec')

    this.busy = true
    const projector = new TurnProjector()
    this.projector = projector
    this.turnToolFacts = []
    const controller = new AbortController()
    const timeoutMs = this.options.requestTimeoutMs ?? 0
    const timer = timeoutMs > 0 ? setTimeout(() => controller.abort(), timeoutMs) : undefined
    try {
      await connection.agent.request(
        'session/prompt',
        { sessionId, prompt: [{ type: 'text', text: spec }] },
        timeoutMs > 0 ? { cancellationSignal: controller.signal } : undefined
      )
      return { text: projector.assistantText }
    } catch (error) {
      this.emit({ kind: 'error', message: messageOf(error) })
      throw error
    } finally {
      if (timer) clearTimeout(timer)
      this.projector = undefined
      this.busy = false
    }
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    const connection = this.connection
    const sessionId = this.sessionId
    this.connection = undefined
    this.sessionId = undefined
    this.projector = undefined
    if (connection && sessionId) {
      try {
        await connection.agent.request('session/close', { sessionId })
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
  }

  private onUpdate(notification: SessionNotification): void {
    const projector = this.projector
    if (!projector) return
    if (notification.sessionId !== this.sessionId) return
    projector.handle(notification.update)
    for (const event of projector.drain()) this.emit(event)
    this.turnToolFacts.push(...projector.drainToolFacts())
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
    const options = params.options ?? []
    const allow = options.find((option) => option.kind === 'allow_once') ?? options.find((option) => option.kind === 'allow_always')
    const reject = options.find((option) => option.kind === 'reject_once') ?? options.find((option) => option.kind === 'reject_always')
    const kind = params.toolCall?.kind ?? 'other'
    const allowedKinds = new Set(['read', 'search', 'think', 'fetch'])
    const permitted = this.options.permission !== 'read-only' || allowedKinds.has(kind)
    if (permitted && allow) {
      this.emit({ kind: 'status', message: `permission granted (${kind})` })
      return { outcome: { outcome: 'selected', optionId: allow.optionId } }
    }
    if (!permitted && reject) {
      this.emit({ kind: 'status', message: `permission denied by read-only (${kind})` })
      return { outcome: { outcome: 'selected', optionId: reject.optionId } }
    }
    this.emit({ kind: 'error', message: `DSH permission request had no ${permitted ? 'allow' : 'reject'} option (${kind})` })
    return { outcome: { outcome: 'cancelled' } }
  }

  private emit(event: ProjectedEvent): void {
    this.options.onEvent?.({ id: randomUUID(), at: new Date().toISOString(), kind: event.kind, message: event.message })
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
