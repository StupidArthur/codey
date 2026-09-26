import type { ExecutionOutcome } from '../../shared/contracts'

/**
 * Structured verification facts. Only the product's own verification executor
 * may produce `passed`/`failed` outcomes (backed by a real exit code); DSH tool
 * telemetry (`ToolCallFact`) is at best an `observed` fact and can never make a
 * verification pass.
 */

export interface FileState {
  exists: boolean
  mtimeMs: number
  size: number
}

export type FileStateMap = Map<string, FileState>

/** One tool call observed over the public ACP transport (DSH provides no exit codes). */
export interface ToolCallFact {
  toolCallId: string
  turn: number
  title: string
  kind: string
  status: 'pending' | 'in_progress' | 'completed' | 'failed'
  at: string
}

/** A verification run executed by the product against the workspace. */
export interface VerificationRun {
  id: string
  turn: number
  label: string
  command: string
  exitCode: number | null
  signal: string | null
  outputTail: string
  scope: 'file' | 'workspace'
  /** Files the check verified; empty means the whole workspace. */
  targets: string[]
  /** Required-spec item ids this run was asked to verify. */
  covers: string[]
  /** Target file states at run time; the evaluator invalidates changed artifacts. */
  stamps: FileStateMap
  outcome: 'passed' | 'failed' | 'observed'
  at: string
}

export interface VerificationRequest {
  label: string
  command: string
  args: string[]
  cwd: string
  scope: 'file' | 'workspace'
  targets: string[]
  covers: string[]
  turn: number
  timeoutMs?: number
}

export type VerificationExecutorFn = (request: VerificationRequest) => Promise<VerificationRun>

interface FileStamp {
  mtimeMs: number
  size: number
}

/**
 * One capture of the workspace state. `preexisting` distinguishes the user's
 * dirty changes that were already present when the round started from the
 * changes the round itself made.
 */
export interface WorkspaceSnapshot {
  git: boolean
  /** Git: files already dirty when this snapshot's round began. */
  preexisting: Set<string>
  /** Non-git: relative path → stamp for every reachable file. */
  files: Map<string, FileStamp>
  /** Git: current dirty set at capture time (path → porcelain code). */
  dirty: Map<string, string>
  /** Every known file including ones deleted since the loop start. */
  fileStates: FileStateMap
}

export interface EvidenceBundle {
  /** Files the round changed since it started (preexisting user changes excluded). */
  changedFiles: string[]
  /** Files changed by the last turn only. */
  turnChangedFiles: string[]
  newFiles: string[]
  /** The user's dirty files that already existed when the round started. */
  preexistingChanges: string[]
  gitDiffSummary?: string
  toolFacts: ToolCallFact[]
  verification: VerificationRun[]
  outcome: ExecutionOutcome
}

export interface CollectResult {
  bundle: EvidenceBundle
  snapshot: WorkspaceSnapshot
}
