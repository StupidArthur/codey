import { randomUUID } from 'node:crypto'
import { DeepSeekHarness, type HarnessNotification } from '@deepseek-ai/dsh-sdk-client'
import type { ModelSettings, RunnerEvent } from '../../shared/contracts'

export interface DshRuntimeOptions {
  workspacePath: string
  settings: ModelSettings
  credential?: string
  onEvent?: (event: RunnerEvent) => void
  /** Optional packaged CLI module override; the SDK otherwise finds matching @deepseek-ai/dsh. */
  dshBin?: string
}

/** One window's long-lived DSH process and one DSH session. */
export class DshRuntime {
  private harness?: DeepSeekHarness
  private sessionId?: string
  private busy = false
  private closed = false

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
    if (!provider || !model) throw new Error('Configure a model provider and model before starting DSH')
    if (this.options.credential && provider !== 'deepseek-official') {
      throw new Error(`Credential environment mapping for provider "${provider}" is not configured`)
    }

    const env: NodeJS.ProcessEnv = { ...process.env }
    // The SDK launches through process.execPath; in a packaged Electron app that is electron.exe.
    if (process.versions.electron) env.ELECTRON_RUN_AS_NODE = '1'
    if (this.options.credential) env.DEEPSEEK_API_KEY = this.options.credential
    if (this.options.settings.baseUrl) env.DEEPSEEK_BASE_URL = this.options.settings.baseUrl
    const harness = new DeepSeekHarness({
      profile: 'sdk',
      dshBin: this.options.dshBin,
      processCwd: this.options.workspacePath,
      env,
      cwd: this.options.workspacePath,
      provider,
      model
    })
    try {
      await harness.start()
      const handle = harness.session(sessionId)
      this.harness = harness
      this.sessionId = handle.id
      return { sessionId: handle.id }
    } catch (error) {
      await harness.close()
      throw error
    }
  }

  async prompt(spec: string): Promise<{ text: string }> {
    if (this.closed) throw new Error('DSH runtime has been closed')
    if (!spec.trim()) throw new Error('Spec must not be empty')
    if (this.busy) throw new Error('DSH session is already running')
    const sessionId = this.sessionId
    const harness = this.harness
    if (!sessionId || !harness) throw new Error('Start the DSH runtime before submitting a Spec')
    this.busy = true
    try {
      const result = await harness.run(spec, {
        sessionId,
        onNotification: (notification) => this.project(notification)
      })
      return { text: result.finalResponse }
    } finally {
      this.busy = false
    }
  }

  async close(): Promise<void> {
    this.closed = true
    const harness = this.harness
    this.harness = undefined
    this.sessionId = undefined
    await harness?.close()
  }

  private project(notification: HarnessNotification): void {
    const params = notification.params
    let kind: RunnerEvent['kind'] = 'status'
    let message: string | undefined
    if (notification.method === 'session.status') {
      message = params.status === 'idle' ? 'DSH is idle' : 'DSH is running'
    } else if (notification.method === 'subagent.started') {
      message = 'Subagent started'
    } else if (notification.method === 'subagent.finished') {
      message = 'Subagent finished'
    } else if (notification.method === 'session.event') {
      const event = params.event
      if (typeof event !== 'object' || event === null) return
      const type = (event as { type?: unknown }).type
      if (typeof type !== 'string') return
      if (type.includes('tool')) kind = 'tool'
      else if (type.includes('error')) kind = 'error'
      else if (type.includes('verification')) kind = 'verification'
      else if (type.includes('assistant')) kind = 'thinking'
      else return
      message = type
    }
    if (!message) return
    this.options.onEvent?.({ id: randomUUID(), at: new Date().toISOString(), kind, message })
  }
}
