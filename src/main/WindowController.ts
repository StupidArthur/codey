import { randomUUID } from 'node:crypto'
import { realpath } from 'node:fs/promises'
import type { BrowserWindow } from 'electron'
import type {
  ModelSettings, PermissionPreset, RoundMode, RunnerEvent,
  SessionListResult, SessionSummary, WorkspaceSnapshot
} from '../shared/contracts'
import { IPC } from '../shared/contracts'
import { DshRuntime, type DshRuntimeComposition } from './dsh/DshRuntime'
import { SessionDiscovery, type DiscoveredDshSession } from './dsh/SessionDiscovery'
import { historyStateFor, mergeSessions } from './dsh/sessionMerge'
import { EvidenceCollector } from './evidence/EvidenceCollector'
import { VerificationExecutor } from './evidence/VerificationExecutor'
import { ProductStore, type SessionLease } from './persistence/ProductStore'
import { ResultBuilder } from './result/ResultBuilder'
import { RoundEngine } from './rounds/RoundEngine'
import { CredentialVault } from './settings/CredentialVault'
import { SessionLogger } from './logging/SessionLogger'

/** Owns exactly one workspace and product session for one BrowserWindow. */
export class WindowController {
  private workspacePath: string | null = null
  private session: SessionSummary | null = null
  private runtime: DshRuntime | null = null
  private runtimeComposition: DshRuntimeComposition | null = null
  private runtimeStart: { composition: DshRuntimeComposition; promise: Promise<DshRuntime> } | null = null
  private lease: SessionLease | null = null
  private running = false
  private cancelRequested = false
  private runnerEvents: RunnerEvent[] = []
  private pendingEvidenceEvents: RunnerEvent[] = []
  private error: string | undefined
  private logger: SessionLogger | null = null
  private activeRunId: string | undefined
  private activeRunStartedAt: number | undefined
  private runnerSnapshotTimer: ReturnType<typeof setTimeout> | undefined
  private readonly discovery = new SessionDiscovery()
  private readonly evidence = new EvidenceCollector()
  private readonly resultBuilder = new ResultBuilder()
  private readonly verificationExecutor = new VerificationExecutor()
  private readonly engine: RoundEngine

  constructor(
    private readonly window: BrowserWindow,
    private readonly store: ProductStore,
    private readonly vault: CredentialVault
  ) {
    this.engine = new RoundEngine({
      store,
      ensureRuntime: (mode) => this.ensureRuntime(mode),
      evidence: this.evidence,
      resultBuilder: this.resultBuilder,
      verify: async (request) => {
        const startedAt = Date.now()
        this.log('verification.start', request)
        try {
          const result = await this.verificationExecutor.run(request)
          this.log('verification.end', { durationMs: Date.now() - startedAt, result })
          return result
        } catch (error) {
          this.log('verification.error', { durationMs: Date.now() - startedAt, error: messageOf(error) })
          throw error
        }
      },
      isCancellationRequested: () => this.cancelRequested,
      takeEvents: () => {
        const events = this.pendingEvidenceEvents
        this.pendingEvidenceEvents = []
        return events
      },
      onDiagnostic: (type, payload) => this.log(type, payload),
      onRoundChanged: async () => { await this.emitSnapshot() }
    })
  }

  async listSessions(path: string): Promise<SessionListResult> {
    const workspacePath = await realpath(path)
    const product = this.store.listSessions(workspacePath)
    let discovered: DiscoveredDshSession[] = []
    let discoveryError: string | undefined
    try {
      discovered = await this.discovery.listByWorkspace(workspacePath)
    } catch (error) {
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

    // Ownership first, recovery second: the lease must be held before any
    // dangling execution of that session is reconciled, so a rejected opener
    // can never mutate another window's live round. If anything fails after
    // the acquire, the new lock is released again and the previous window's
    // ownership is untouched.
    const nextLease = this.store.acquireSessionLease(nextSession.id, () => {
      this.error = 'Session 的独占锁已丢失，请重新打开。'
      void this.closeRuntime()
      void this.emitSnapshot()
    })
    try {
      this.store.reconcileInterruptedRounds(nextSession.id)
      await this.releaseCurrent()
      this.lease = nextLease
      this.workspacePath = workspacePath
      this.session = nextSession
      this.logger = new SessionLogger(nextSession.id)
      this.log('session.open', { title: nextSession.title, workspacePath, dshSessionId: nextSession.dshSessionId, permission: nextSession.permission, logFile: this.logger.filePath })
      if (this.runnerSnapshotTimer) {
        clearTimeout(this.runnerSnapshotTimer)
        this.runnerSnapshotTimer = undefined
      }
      this.runnerEvents = []
      this.pendingEvidenceEvents = []
      this.error = undefined
      const snapshot = await this.emitSnapshot()
      this.prewarmRuntime(snapshot.mode, 'session.open')
      return snapshot
    } catch (error) {
      try { nextLease.release() } catch { /* best effort */ }
      throw error
    }
  }

  async getSnapshot(): Promise<WorkspaceSnapshot> {
    // Re-read the projection so derived fields (kind, hasTemporalHistory,
    // permission, DSH id) reflect the latest committed state.
    if (this.session) this.session = this.store.getSession(this.session.id) ?? this.session
    const settings = await this.getModelSettings()
    const draft = this.session ? this.store.getDraft(this.session.id) : { draft: '', mode: 'plan' as RoundMode }
    const rounds = this.session ? this.store.listRoundDetails(this.session.id) : []
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
      permission: this.session?.permission ?? 'workspace-write',
      ...(this.error ? { error: this.error } : {})
    }
  }

  async saveDraft(draft: string, mode: RoundMode): Promise<void> {
    this.assertOwnership()
    const session = this.requireSession()
    this.store.saveDraft(session.id, draft, mode)
    this.prewarmRuntime(mode, 'draft.save')
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
    await this.closeRuntime()
    const saved = await this.getModelSettings()
    const snapshot = await this.emitSnapshot()
    this.prewarmRuntime(snapshot.mode, 'settings.changed')
    return saved
  }

  async setPermission(preset: PermissionPreset): Promise<void> {
    this.assertOwnership()
    const session = this.requireSession()
    if (this.running) throw new Error('运行期间不能修改权限。')
    this.store.setPermission(session.id, preset)
    this.session = { ...session, permission: preset }
    await this.closeRuntime()
    const snapshot = await this.emitSnapshot()
    this.prewarmRuntime(snapshot.mode, 'permission.changed')
  }

  async submit(spec: string, mode: RoundMode): Promise<void> {
    this.assertOwnership()
    const session = this.requireSession()
    if (this.running) throw new Error('当前已有执行任务。')
    if (!spec.trim()) throw new Error('Spec 不能为空。')
    const settings = await this.getModelSettings()
    if (!settings.provider || !settings.model) throw new Error('请先配置模型 Provider 和 Model。')

    const submittedRevision = this.store.getDraftWithRevision(session.id).revision
    const submitStartedAt = Date.now()
    this.activeRunId = randomUUID()
    this.activeRunStartedAt = submitStartedAt
    this.log('submit.start', { mode, spec, provider: settings.provider, model: settings.model, baseUrl: settings.baseUrl, permission: session.permission, dshSessionId: session.dshSessionId })
    this.cancelRequested = false
    this.running = true
    this.error = undefined
    this.runnerEvents = []
    this.pendingEvidenceEvents = []
    await this.emitSnapshot()

    try {
      const result = await this.engine.submit({ session, mode, spec })
      this.log('submit.end', { mode, outcome: result.outcome, roundId: result.roundId, durationMs: Date.now() - submitStartedAt })
      if (result.outcome !== 'interrupted') this.store.clearDraftIfRevision(session.id, submittedRevision)
    } catch (error) {
      this.log('submit.error', { mode, durationMs: Date.now() - submitStartedAt, cancelled: this.cancelRequested, error: messageOf(error) })
      if (!this.cancelRequested) {
        this.error = error instanceof Error ? error.message : String(error)
        await this.closeRuntime()
        throw error
      }
      this.error = undefined
    } finally {
      this.log('submit.finalize', { mode, durationMs: Date.now() - submitStartedAt, cancelRequested: this.cancelRequested })
      this.running = false
      this.cancelRequested = false
      this.activeRunId = undefined
      this.activeRunStartedAt = undefined
      // Keep the last runner events long enough for the close animation and
      // post-run inspection. The next submit clears them before it starts.
      this.pendingEvidenceEvents = []
      await this.emitSnapshot()
    }
  }

  async cancelRun(): Promise<boolean> {
    this.assertOwnership()
    if (!this.running) return false
    if (this.cancelRequested) return true
    this.cancelRequested = true
    this.log('cancel.requested', { dshSessionId: this.session?.dshSessionId })
    const runtime = this.runtime
    const delivered = runtime ? await runtime.cancelTurn() : false
    this.log('cancel.result', { delivered, dshSessionId: this.session?.dshSessionId })
    await this.emitSnapshot()
    return true
  }

  async endRound(): Promise<void> {
    this.assertOwnership()
    const session = this.requireSession()
    if (this.running) throw new Error('运行期间不能结束当前轮次。')
    await this.engine.endCurrent(session)
    await this.emitSnapshot()
  }

  async dispose(): Promise<void> {
    await this.releaseCurrent()
  }

  private requireSession(): SessionSummary {
    if (!this.session) throw new Error('请先选择 Workspace 和 Session。')
    return this.session
  }

  /** Protected-state guard: a window that lost its lease may not mutate the
   *  session (drafts, rounds, permission) or restart its runtime. */
  private assertOwnership(): void {
    if (!this.lease) throw new Error('请先选择 Workspace 和 Session。')
    this.lease.assertHeld()
  }

  private compositionForMode(mode: RoundMode): DshRuntimeComposition {
    return mode === 'vibe' ? 'minimal' : 'full'
  }

  /**
   * Best-effort runtime warmup. Session open and draft-mode changes can pay the
   * DSH/ACP startup cost while the user is still editing. Failures are logged
   * only; submit remains the authoritative retry path.
   */
  private prewarmRuntime(mode: RoundMode, reason: string): void {
    if (!this.session || !this.lease || this.running) return
    const composition = this.compositionForMode(mode)
    if (this.runtimeComposition === composition || this.runtimeStart?.composition === composition) return
    this.log('runtime.prewarm.start', { mode, composition, reason })
    void this.ensureRuntime(mode)
      .then(runtime => {
        if (this.runtime === runtime && this.runtimeComposition === composition) {
          this.log('runtime.prewarm.end', { mode, composition, reason, dshSessionId: this.session?.dshSessionId })
        }
      })
      .catch(error => {
        this.log('runtime.prewarm.error', { mode, composition, reason, error: messageOf(error) })
      })
  }

  private async ensureRuntime(mode: RoundMode): Promise<DshRuntime> {
    this.assertOwnership()
    const composition = this.compositionForMode(mode)

    if (this.runtime && this.runtimeComposition === composition) return this.runtime

    const starting = this.runtimeStart
    if (starting) {
      if (starting.composition === composition) return starting.promise
      try { await starting.promise } catch { /* the requested composition will retry below */ }
      if (this.runtime && this.runtimeComposition === composition) return this.runtime
    }

    if (this.runtime && this.runtimeComposition !== composition) {
      this.log('runtime.switch', { from: this.runtimeComposition, to: composition, mode })
      await this.closeRuntime()
    }

    const promise = this.startRuntime(mode, composition)
    this.runtimeStart = { composition, promise }
    try {
      return await promise
    } finally {
      if (this.runtimeStart?.promise === promise) this.runtimeStart = null
    }
  }

  private async startRuntime(mode: RoundMode, composition: DshRuntimeComposition): Promise<DshRuntime> {
    const session = this.requireSession()
    const settings = await this.getModelSettings()
    const runtime = new DshRuntime({
      workspacePath: session.workspacePath,
      settings,
      composition,
      credential: await this.vault.getCredential(),
      permission: session.permission,
      onEvent: (event) => this.appendRunnerEvent(event),
      onDebug: (type, payload) => this.log(type, payload)
    })
    const existing = this.store.getDshSessionId(session.id)
    this.log('runtime.ensure', {
      mode,
      composition,
      existingDshSessionId: existing,
      provider: settings.provider,
      model: settings.model,
      baseUrl: settings.baseUrl
    })
    try {
      const started = await runtime.start(existing)
      if (!existing) {
        this.store.setDshSessionId(session.id, started.sessionId)
        this.session = { ...session, dshSessionId: started.sessionId, kind: session.kind === 'new' ? 'legacy' : session.kind }
      }
      this.runtime = runtime
      this.runtimeComposition = composition
      this.log('runtime.ready', { mode, composition, dshSessionId: started.sessionId })
      return runtime
    } catch (error) {
      // A failed warmup/start must not leak a partially started runtime.
      try { await runtime.close() } catch { /* best effort */ }
      throw error
    }
  }

  private async closeRuntime(): Promise<void> {
    const starting = this.runtimeStart
    if (starting) {
      try { await starting.promise } catch { /* failed starts are already cleaned up */ }
    }
    const runtime = this.runtime
    const composition = this.runtimeComposition
    this.runtime = null
    this.runtimeComposition = null
    if (runtime) {
      this.log('runtime.dispose', { composition })
      await runtime.close()
    }
  }

  private async releaseCurrent(): Promise<void> {
    if (this.runnerSnapshotTimer) {
      clearTimeout(this.runnerSnapshotTimer)
      this.runnerSnapshotTimer = undefined
    }
    await this.closeRuntime()
    await this.logger?.flush()
    this.logger = null
    const lease = this.lease
    this.lease = null
    if (lease) {
      try { lease.assertHeld() } catch { /* already lost */ }
      lease.release()
    }
  }

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

  private appendRunnerEvent(event: RunnerEvent): void {
    this.log('runner.event', event)
    this.runnerEvents.push(event)
    if (this.runnerEvents.length > 200) this.runnerEvents.shift()
    this.pendingEvidenceEvents.push(event)
    if (this.pendingEvidenceEvents.length > 1000) this.pendingEvidenceEvents.shift()
    this.scheduleRunnerSnapshot()
  }

  private scheduleRunnerSnapshot(): void {
    if (this.runnerSnapshotTimer) return
    this.runnerSnapshotTimer = setTimeout(() => {
      this.runnerSnapshotTimer = undefined
      void this.emitSnapshot()
    }, 100)
    this.runnerSnapshotTimer.unref?.()
  }

  private log(type: string, payload?: unknown): void {
    this.logger?.write(type, payload, {
      ...(this.activeRunId ? { runId: this.activeRunId } : {}),
      ...(this.activeRunStartedAt !== undefined ? { runElapsedMs: Date.now() - this.activeRunStartedAt } : {})
    })
  }

  private async emitSnapshot(): Promise<WorkspaceSnapshot> {
    const startedAt = Date.now()
    const snapshot = await this.getSnapshot()
    const durationMs = Date.now() - startedAt
    if (this.activeRunId) {
      this.log('snapshot.build', {
        durationMs,
        rounds: snapshot.rounds.length,
        runnerEvents: snapshot.runnerEvents.length,
        vibeEntries: snapshot.rounds.reduce((total, round) => total + round.vibeEntries.length, 0),
        evidence: snapshot.rounds.reduce((total, round) => total + round.evidence.length, 0)
      })
    }
    if (!this.window.isDestroyed()) this.window.webContents.send(IPC.snapshotChanged, snapshot)
    return snapshot
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
