export type RoundMode = 'plan' | 'vibe' | 'loop'
export type RoundStatus = 'active' | 'completed' | 'blocked' | 'budget_exhausted' | 'failed' | 'interrupted'
export type ExecutionOutcome = 'completed' | 'failed' | 'blocked' | 'interrupted'

/** Session-level permission preset. Plan/Vibe/Loop never escalate it. */
export type PermissionPreset = 'read-only' | 'workspace-write' | 'danger-full-access'

/**
 * `new` — a Temporal Session with no DSH identity yet.
 * `temporal` — has at least one Temporal Round.
 * `legacy` — an existing DSH Session with no Temporal Round; legacy history is
 * inherited read-only and is not reconstructed.
 */
export type SessionKind = 'new' | 'temporal' | 'legacy'

export interface SessionSummary {
  id: string
  /** Present once the session is bound to a DSH Session. */
  dshSessionId?: string
  title: string
  workspacePath: string
  updatedAt: string
  hasTemporalHistory: boolean
  kind: SessionKind
  permission: PermissionPreset
}

/** Result of a workspace listing: product records merged with ACP discovery. */
export interface SessionListResult {
  sessions: SessionSummary[]
  /** Set when public ACP discovery failed; product records are still returned. */
  discoveryError?: string
}

/** Legacy history is inherited, never reconstructed, and currently not readable. */
export type HistoryState = 'none' | 'legacy-unavailable'

export interface RoundSummary {
  id: string
  sequence: number
  mode: RoundMode
  status: RoundStatus
  title: string
  updatedAt: string
  bodyMarkdown: string
}

export interface PlanVersionSummary {
  id: string
  ordinal: number
  submittedSpec: string
  planMarkdown: string
  createdAt: string
}

export interface VibeEntrySummary {
  id: string
  ordinal: number
  specMarkdown: string
  assistantOutput: string
  executionOutcome: ExecutionOutcome
  createdAt: string
}

export interface EvidenceSummary {
  id: string
  kind: 'command' | 'workspace' | 'artifact' | 'manual' | 'runtime'
  label: string
  detail: string
  outcome: 'passed' | 'failed' | 'observed'
  provenance: 'tool' | 'user' | 'model'
  observedAt: string
}

export interface LoopTerminalSummary {
  status: 'completed' | 'blocked' | 'budget_exhausted' | 'failed'
  reason: string
}

export interface ResultSummary {
  summary: string
  changes: string[]
  verification: string[]
  remaining: string[]
  loopTerminal?: LoopTerminalSummary
  createdAt: string
}

/** A Round plus its mode-specific projection. */
export interface RoundDetail extends RoundSummary {
  planVersions: PlanVersionSummary[]
  vibeEntries: VibeEntrySummary[]
  evidence: EvidenceSummary[]
  result?: ResultSummary
}

export interface RunnerEvent {
  id: string
  at: string
  kind: 'thinking' | 'tool' | 'verification' | 'error' | 'status'
  message: string
}

export interface ModelSettings {
  provider: string
  model: string
  baseUrl?: string
  hasCredential: boolean
}

export interface WorkspaceSnapshot {
  workspacePath: string | null
  session: SessionSummary | null
  rounds: RoundDetail[]
  /** Explicit state for the legacy-history placeholder; never fakes a History document. */
  historyState: HistoryState
  draft: string
  mode: RoundMode
  running: boolean
  runnerEvents: RunnerEvent[]
  settings: ModelSettings
  permission: PermissionPreset
  error?: string
}

export interface TemporalApi {
  chooseWorkspace(): Promise<string | null>
  listSessions(workspacePath: string): Promise<SessionListResult>
  openSession(workspacePath: string, sessionId?: string): Promise<WorkspaceSnapshot>
  getSnapshot(): Promise<WorkspaceSnapshot>
  saveDraft(draft: string, mode: RoundMode): Promise<void>
  submit(spec: string, mode: RoundMode): Promise<void>
  endRound(): Promise<void>
  setPermission(preset: PermissionPreset): Promise<void>
  getModelSettings(): Promise<ModelSettings>
  saveModelSettings(settings: Omit<ModelSettings, 'hasCredential'> & { credential?: string }): Promise<ModelSettings>
  onSnapshot(listener: (snapshot: WorkspaceSnapshot) => void): () => void
}

export const IPC = {
  chooseWorkspace: 'workspace:choose',
  listSessions: 'session:list',
  openSession: 'session:open',
  getSnapshot: 'workspace:snapshot',
  saveDraft: 'workspace:save-draft',
  submit: 'round:submit',
  endRound: 'round:end',
  setPermission: 'settings:permission:set',
  getModelSettings: 'settings:model:get',
  saveModelSettings: 'settings:model:save',
  snapshotChanged: 'workspace:changed'
} as const
