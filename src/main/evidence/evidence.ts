import { createHash } from 'node:crypto'
import type { CheckFact, ExecutionOutcome, PermissionPreset } from '../../shared/contracts'

export type { CheckFact }

/** Workspace directory for sandbox verification artifacts (never dotted: the
 *  collector must track these files for validity stamping while the loop
 *  excludes them from task-change/progress accounting). */
export const VERIFY_DIR = 'temporal-verify'
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
  /**
   * Sandbox checks only: the nonce identifying the exact request that produced
   * this run. A leftover artifact from a different request (a previous Round's
   * fixed-name `.exit` file) can never satisfy the current request because the
   * check reads the request-specific artifact path.
   */
  requestId?: string
  /**
   * Sandbox checks only: the input fingerprint of the workspace inputs the
   * check was requested against. The run is only a CURRENT pass while the
   * present inputs still produce the same fingerprint.
   */
  inputFingerprint?: string
  /**
   * Stable identity of the check object across re-runs. Sandbox runs carry
   * `sandbox:<kind>`; a re-check (any request nonce) supersedes the previous
   * run of the same object, so old failures/passes never pollute the current
   * conclusion. Falls back to method+command+targets when absent.
   */
  checkObject?: string
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
  /** The repository-script kind this request verifies through a sandbox wrapper. */
  sandbox?: { kind: 'tests' | 'typecheck' | 'build' }
  requestId?: string
  inputFingerprint?: string
  checkObject?: string
}

/**
 * Input fingerprint of the workspace the check corresponds to. Content-first:
 * entries carry the content hash (mtime-only touches with identical content do
 * not change the fingerprint); files without a hash fall back to size+mtime.
 * Additions and deletions change the fingerprint because the path set is part
 * of it. Product verification artifacts (`temporal-verify`), dependency
 * directories (`node_modules`) and explicit build outputs (`dist`/`out`/
 * `build`/`release`) are excluded: they are not project inputs, and a check's
 * own logs/exit files must never invalidate their own check. Git metadata is
 * already absent from the snapshot (dot-directories are skipped). This is a
 * conservative association with the current snapshot's project input files; it
 * does not promise to cover every possible external dependency.
 */
export function inputFingerprint(fileStates: FileStateMap): string {
  const parts: string[] = []
  for (const [file, state] of fileStates) {
    if (isExcludedInput(file)) continue
    if (!state.exists) {
      parts.push(`${file}\u0000absent`)
      continue
    }
    parts.push(`${file}\u0000${state.hash ?? `${state.size}:${state.mtimeMs}`}`)
  }
  parts.sort()
  return createHash('sha1').update(parts.join('\n'), 'utf8').digest('hex')
}

const EXCLUDED_INPUT_PREFIXES = ['temporal-verify', 'node_modules', 'dist', 'out', 'build', 'release', '.git']

function isExcludedInput(file: string): boolean {
  for (const prefix of EXCLUDED_INPUT_PREFIXES) {
    if (file === prefix || file.startsWith(`${prefix}/`)) return true
  }
  return false
}

export type VerificationExecutorFn = (request: VerificationRequest) => Promise<VerificationRun>

export interface EvidenceBundle {
  changedFiles: string[]
  turnChangedFiles: string[]
  newFiles: string[]
  /** Files present at the round baseline that are gone now (real deletions). */
  deletedFiles: string[]
  preexistingChanges: string[]
  /** Git porcelain XY status per changed path (git workspaces only). */
  fileStatus?: Map<string, string>
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
