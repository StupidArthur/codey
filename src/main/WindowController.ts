import { randomUUID } from 'node:crypto'
import { realpath } from 'node:fs/promises'
import type { BrowserWindow } from 'electron'
import type { ModelSettings, RoundMode, RoundSummary, RunnerEvent, SessionListResult, SessionSummary, WorkspaceSnapshot } from '../shared/contracts'
import { IPC } from '../shared/contracts'
import { DshRuntime } from './dsh/DshRuntime'
import { SessionDiscovery, type DiscoveredDshSession } from './dsh/SessionDiscovery'
import { historyStateFor, mergeSessions } from './dsh/sessionMerge'
import { ProductStore } from './persistence/ProductStore'
import { CredentialVault } from './settings/CredentialVault'

/** Owns exactly one workspace and product session for one BrowserWindow. */
export class WindowController {
  private workspacePath: string | null = null
  private session: SessionSummary | null = null
  private runtime: DshRuntime | null = null
  private running = false
  private runnerEvents: RunnerEvent[] = []
  private error: string | undefined
  private readonly discovery = new SessionDiscovery()

  constructor(
    private readonly window: BrowserWindow,
    private readonly store: ProductStore,
    private readonly vault: CredentialVault,
    private readonly claimSession: (sessionId: string, windowId: number) => void,
    private readonly releaseSession: (sessionId: string, windowId: number) => void
  ) {}

  async listSessions(path: string): Promise<SessionListResult> {
    const workspacePath = await realpath(path)
    const product = this.store.listSessions(workspacePath)
    let discovered: DiscoveredDshSession[] = []
    let discoveryError: string | undefined
    try {
      discovered = await this.discovery.listByWorkspace(workspacePath)
    } catch (error) {
      // Product records stay usable when public ACP discovery fails.
      discoveryError = error instanceof Error ? error.message : String(error)
    }
    return { sessions: mergeSessions(product, discovered, workspacePath), ...(discoveryError ? { discoveryError } : {}) }
  }

  async openSession(path: string, sessionId?: string): Promise<WorkspaceSnapshot> {
    if (this.running) throw new Error('当前 Session 正在运行，不能切换。')
    const workspacePath = await realpath(path)
    let nextSession: SessionSummary
    if (sessionId) {
      const saved = this.store.getSession(sessionId)
      if (saved) {
        if (saved.workspacePath !== workspacePath) throw new Error('Session 不属于这个 Workspace。')
        nextSession = saved
      } else {
        nextSession = await this.projectDiscoveredSession(workspacePath, sessionId)
      }
    } else {
      nextSession = this.store.createSession(workspacePath)
    }

    if (this.session?.id === nextSession.id) return this.getSnapshot()

    const nextDshId = this.store.getDshSessionId(nextSession.id)
    this.claimSession(`product:${nextSession.id}`, this.window.id)
    if (nextDshId) this.claimSession(`dsh:${nextDshId}`, this.window.id)
    try {
      await this.releaseCurrent()
      this.workspacePath = workspacePath
      this.session = nextSession
      this.runnerEvents = []
      this.error = undefined
      return await this.emitSnapshot()
    } catch (error) {
      this.releaseSession(`product:${nextSession.id}`, this.window.id)
      if (nextDshId) this.releaseSession(`dsh:${nextDshId}`, this.window.id)
      throw error
    }
  }

  async getSnapshot(): Promise<WorkspaceSnapshot> {
    const settings = await this.getModelSettings()
    const draft = this.session ? this.store.getDraft(this.session.id) : { draft: '', mode: 'plan' as RoundMode }
    const rounds = this.session ? this.store.listRounds(this.session.id) : []
    return {
      workspacePath: this.workspacePath,
      session: this.session,
      rounds,
      historyState: historyStateFor(this.session, rounds.length),
      draft: draft.draft,
      mode: draft.mode,
      running: this.running,
      runnerEvents: [...this.runnerEvents],
      settings,
      ...(this.error ? { error: this.error } : {})
    }
  }

  async saveDraft(draft: string, mode: RoundMode): Promise<void> {
    const session = this.requireSession()
    if (!this.running) {
      const latest = this.store.listRounds(session.id).at(-1)
      if (latest?.status === 'active' && latest.mode !== mode) {
        latest.status = 'completed'
        latest.updatedAt = new Date().toISOString()
        this.store.saveRound(session.id, latest)
      }
    }
    this.store.saveDraft(session.id, draft, mode)
    await this.emitSnapshot()
  }

  async getModelSettings(): Promise<ModelSettings> {
    return { ...this.store.getModelSettings(), hasCredential: await this.vault.hasCredential() }
  }

  async saveModelSettings(settings: Omit<ModelSettings, 'hasCredential'> & { credential?: string }): Promise<ModelSettings> {
    if (this.running) throw new Error('运行期间不能修改模型设置。')
    if (!settings.provider.trim() || !settings.model.trim()) throw new Error('请填写 Provider 和 Model。')
    if (settings.credential) await this.vault.setCredential(settings.credential)
    this.store.saveModelSettings(settings)
    if (this.runtime) {
      await this.runtime.close()
      this.runtime = null
    }
    const saved = await this.getModelSettings()
    await this.emitSnapshot()
    return saved
  }

  async submit(spec: string, mode: RoundMode): Promise<void> {
    const session = this.requireSession()
    if (this.running) throw new Error('当前已有执行任务。')
    if (!spec.trim()) throw new Error('Spec 不能为空。')
    if (mode === 'loop') throw new Error('Loop Controller 尚未接入真实验证与预算控制。')

    const settings = await this.getModelSettings()
    if (!settings.provider || !settings.model) throw new Error('请先配置模型 Provider 和 Model。')
    const submittedRevision = this.store.getDraftWithRevision(session.id).revision
    this.running = true
    this.error = undefined
    this.runnerEvents = []
    await this.emitSnapshot()

    let round: RoundSummary | undefined
    let newDshId: string | undefined
    try {
      if (!this.runtime) {
        this.runtime = new DshRuntime({
          workspacePath: session.workspacePath,
          settings,
          credential: await this.vault.getCredential(),
          onEvent: (event) => this.appendRunnerEvent(event)
        })
        const dshSessionId = this.store.getDshSessionId(session.id)
        const started = await this.runtime.start(dshSessionId)
        if (!dshSessionId) newDshId = started.sessionId
      }

      const rounds = this.store.listRounds(session.id)
      const latest = rounds.at(-1)
      if (latest?.status === 'active' && latest.mode !== mode) {
        latest.status = 'completed'
        latest.updatedAt = new Date().toISOString()
        this.store.saveRound(session.id, latest)
      }
      round = latest && latest.mode === mode && latest.status === 'active'
        ? latest
        : {
            id: randomUUID(), sequence: rounds.length + 1, mode, status: 'active',
            title: spec.split('\n').find((line) => line.trim() && !line.startsWith('#'))?.slice(0, 64) || mode,
            updatedAt: new Date().toISOString(), bodyMarkdown: ''
          }
      this.store.saveRound(session.id, round)
      const result = await this.runtime.prompt(spec)
      if (newDshId) {
        this.claimSession(`dsh:${newDshId}`, this.window.id)
        this.store.setDshSessionId(session.id, newDshId)
      }
      // The SDK response is preserved verbatim. ResultBuilder will later add evidence-backed sections.
      round.bodyMarkdown = round.bodyMarkdown
        ? `${round.bodyMarkdown}\n\n---\n\n${result.text}`
        : result.text
      round.updatedAt = new Date().toISOString()
      this.store.saveRound(session.id, round)
      this.store.clearDraftIfRevision(session.id, submittedRevision)
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error)
      if (this.runtime) {
        await this.runtime.close()
        this.runtime = null
      }
      if (round) {
        round.status = 'failed'
        round.updatedAt = new Date().toISOString()
        this.store.saveRound(session.id, round)
      }
      throw error
    } finally {
      this.running = false
      this.runnerEvents = []
      await this.emitSnapshot()
    }
  }

  async endRound(): Promise<void> {
    const session = this.requireSession()
    if (this.running) throw new Error('运行期间不能结束当前轮次。')
    const latest = this.store.listRounds(session.id).at(-1)
    if (!latest || latest.status !== 'active') return
    latest.status = 'completed'
    latest.updatedAt = new Date().toISOString()
    this.store.saveRound(session.id, latest)
    await this.emitSnapshot()
  }

  async dispose(): Promise<void> {
    await this.releaseCurrent()
  }

  private requireSession(): SessionSummary {
    if (!this.session) throw new Error('请先选择 Workspace 和 Session。')
    return this.session
  }

  /**
   * First open of a discovered legacy DSH Session creates its product projection.
   * Membership is verified against public ACP discovery so a fabricated id cannot
   * create a phantom projection.
   */
  private async projectDiscoveredSession(workspacePath: string, dshSessionId: string): Promise<SessionSummary> {
    const existing = this.store.getSessionByDshId(dshSessionId)
    if (existing) {
      if (existing.workspacePath !== workspacePath) throw new Error('该 DSH Session 属于另一个 Workspace。')
      return existing
    }
    const discovered = await this.discovery.listByWorkspace(workspacePath)
    const match = discovered.find((item) => item.id === dshSessionId)
    if (!match) throw new Error('未在公共 ACP 列表中找到该 DSH Session，未建立产品投影。')
    return this.store.createSession(workspacePath, match.id, match.title ?? 'Existing DSH Session')
  }

  private async releaseCurrent(): Promise<void> {
    if (this.runtime) {
      await this.runtime.close()
      this.runtime = null
    }
    if (this.session) {
      this.releaseSession(`product:${this.session.id}`, this.window.id)
      const dshId = this.store.getDshSessionId(this.session.id)
      if (dshId) this.releaseSession(`dsh:${dshId}`, this.window.id)
    }
  }

  private appendRunnerEvent(event: RunnerEvent): void {
    this.runnerEvents.push(event)
    if (this.runnerEvents.length > 200) this.runnerEvents.shift()
    void this.emitSnapshot()
  }

  private async emitSnapshot(): Promise<WorkspaceSnapshot> {
    const snapshot = await this.getSnapshot()
    if (!this.window.isDestroyed()) this.window.webContents.send(IPC.snapshotChanged, snapshot)
    return snapshot
  }
}
