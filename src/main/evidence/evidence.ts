import type { CheckFact, ExecutionOutcome, PermissionPreset } from '../../shared/contracts'

export type { CheckFact }
/**
 * Structured verification facts. Only the product's own verification executor
 * may produce `passed`/`failed` verification verdicts; DSH tool telemetry
 * (`ToolCallFact`) is at best an `observed` fact and can never make a
 * verification pass.
 */

export interface FileState {
  exists: boolean
  mtimeMs: number
  size: number
  /** sha1 of the content for bounded-size files; detects same-size/same-mtime edits. */
  hash?: string
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

/** How the executor performs a check. Built-in checks are path-constrained read-only APIs. */
export type CheckMethod =
  | { kind: 'file-exists'; target: string }
  | { kind: 'content-equals'; target: string; expected: string }
  | { kind: 'field-equals'; target: string; key: string; expected: string }
  | { kind: 'shell'; command: string; args: string[] }

/** The session permission under which a verification is requested (fail closed when missing). */
export interface VerificationPermission {
  preset: PermissionPreset
  /** Canonical workspace path the verification is confined to. */
  workspacePath: string
}

/**
 * A verification run executed by the product against the workspace. `facts`
 * records what was actually checked and observed; which requirement (if any)
 * a fact satisfies is decided separately by the evaluator, never by the
 * requester of the check.
 */
export interface VerificationRun {
  id: string
  turn: number
  label: string
  /** 'builtin' checks use path-constrained read-only APIs; 'shell' spawns a process. */
  method: 'builtin' | 'shell'
  command: string
  exitCode: number | null
  signal: string | null
  outputTail: string
  scope: 'file' | 'workspace'
  /** Files the check verified; empty means the whole workspace. */
  targets: string[]
  /** Facts actually recorded by the executor. */
  facts: CheckFact[]
  /** Target file states at run time; the evaluator invalidates changed artifacts. */
  stamps: FileStateMap
  outcome: 'passed' | 'failed' | 'denied' | 'observed'
  /** Present when the executor refused to run the check (permission boundary). */
  denial?: string
  at: string
}

export interface VerificationRequest {
  label: string
  method: CheckMethod
  cwd: string
  scope: 'file' | 'workspace'
  targets: string[]
  turn: number
  timeoutMs?: number
  permission?: VerificationPermission
}

export type VerificationExecutorFn = (request: VerificationRequest) => Promise<VerificationRun>

export interface EvidenceBundle {
  changedFiles: string[]
  turnChangedFiles: string[]
  newFiles: string[]
  preexistingChanges: string[]
  gitDiffSummary?: string
  toolFacts: ToolCallFact[]
  verification: VerificationRun[]
  outcome: ExecutionOutcome
}

export interface WorkspaceSnapshot {
  git: boolean
  preexisting: Set<string>
  files: Map<string, { mtimeMs: number; size: number; hash?: string }>
  dirty: Map<string, string>
  fileStates: FileStateMap
}

export interface CollectResult {
  bundle: EvidenceBundle
  snapshot: WorkspaceSnapshot
}
