import type { ExecutionOutcome, LoopTerminalSummary, PermissionPreset, RunnerEvent } from '../../shared/contracts'
import type { DshRuntime } from '../dsh/DshRuntime'
import type { EvidenceCollector } from '../evidence/EvidenceCollector'
import type { EvidenceBundle, ToolCallFact, VerificationRequest, VerificationRun, VerificationExecutorFn } from '../evidence/evidence'
import { describeMethod } from '../evidence/VerificationExecutor'
import { LoopEvaluator, type CheckRequest, type LoopDecision, type WorkspaceHints } from './LoopEvaluator'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

export interface LoopBudget {
  maxContinuations: number
  maxElapsedMs: number
  maxNoProgress: number
  maxSameError: number
}

/** Frozen V1 defaults from the final system design. */
export const DEFAULT_LOOP_BUDGET: LoopBudget = {
  maxContinuations: 16,
  maxElapsedMs: 2 * 60 * 60 * 1000,
  maxNoProgress: 3,
  maxSameError: 2
}

export interface LoopRunInput {
  rootSpec: string
  workspacePath: string
  /** Session permission preset the verification executor must obey. */
  permission: PermissionPreset
  takeEvents: () => RunnerEvent[]
}

export interface LoopRunResult {
  terminal: LoopTerminalSummary
  finalResponse: string
  evidence: EvidenceBundle
  continuations: number
  decision?: LoopDecision
}

/** Structured blocker marker the model is instructed to emit; not a broad regex. */
const BLOCKED_MARKER = /^\[BLOCKED\]/m

/**
 * Evidence-gated loop with a four-condition completion gate. Completion is
 * never taken from the model's claim or from DSH tool completion: every
 * required item must be backed by currently-valid, relevant verification that
 * the product's own executor ran to exit 0, with no known counter-evidence.
 * The remaining gaps and workspace issues become the next continuation prompt.
 * Budgets stop the loop.
 */
export class LoopController {
  private readonly evaluator = new LoopEvaluator()

  constructor(
    private readonly runtime: DshRuntime,
    private readonly collector: EvidenceCollector,
    private readonly budget: LoopBudget = DEFAULT_LOOP_BUDGET,
    /** Wall-clock source; injectable so budget boundaries are testable without waiting. */
    private readonly now: () => number = Date.now,
    private readonly verify?: VerificationExecutorFn
  ) {}

  async run(input: LoopRunInput): Promise<LoopRunResult> {
    const startedAt = this.now()
    const errorCounts = new Map<string, number>()
    const startSnapshot = await this.collector.baseline(input.workspacePath)
    const changedTurnByFile = new Map<string, number>()
    const hints = await workspaceHints(input.workspacePath)
    let prevSnapshot = startSnapshot
    let allRuns: VerificationRun[] = []
    let noProgress = 0
    let continuations = 0
    let turn = 0
    let finalResponse = ''
    let prompt = input.rootSpec
    let failure: string | undefined

    for (;;) {
      turn += 1
      failure = undefined
      let text = ''
      try {
        text = (await this.runtime.prompt(prompt)).text
      } catch (error) {
        failure = error instanceof Error ? error.message : String(error)
      }
      const events = input.takeEvents()
      const toolFacts = (this.runtime.takeToolFacts?.() ?? []).map((fact: ToolCallFact) => ({ ...fact, turn }))
      const outcome: ExecutionOutcome = failure ? 'failed' : 'completed'
      const { bundle, snapshot } = await this.collector.collect(
        input.workspacePath, startSnapshot, prevSnapshot, events, toolFacts, outcome
      )
      prevSnapshot = snapshot
      for (const file of bundle.turnChangedFiles) changedTurnByFile.set(file, turn)
      bundle.verification = allRuns

      if (failure) {
        const count = (errorCounts.get(failure) ?? 0) + 1
        errorCounts.set(failure, count)
        if (count >= this.budget.maxSameError) {
          return this.finish('failed', `Same error repeated ${count} times: ${truncate(failure)}`, finalResponse, bundle, continuations)
        }
      } else {
        finalResponse = text
        if (BLOCKED_MARKER.test(text)) {
          return this.finish('blocked', 'The model reported that it needs user input to continue.', finalResponse, bundle, continuations)
        }

        let decision = this.evaluator.decide({
          rootSpec: input.rootSpec, bundle, fileStates: snapshot.fileStates, changedTurnByFile, turn, hints
        })
        if (decision.decision === 'completed') {
          return this.finish('completed', decision.reason, finalResponse, bundle, continuations, decision)
        }

        const newRuns: VerificationRun[] = []
        if (this.verify && decision.nextChecks.length > 0) {
          for (const request of decision.nextChecks) {
            try {
              newRuns.push(await this.verify(this.withCwd(request, input, turn)))
            } catch (error) {
              newRuns.push({
                id: `verr-${newRuns.length}-${turn}`,
                turn, label: request.label, method: request.method.kind === 'shell' ? 'shell' : 'builtin',
                command: describeMethod(request.method),
                exitCode: null, signal: null, outputTail: String((error as Error)?.message ?? error).slice(0, 300),
                scope: request.scope, targets: request.targets, facts: [], stamps: new Map(),
                outcome: 'observed', at: new Date().toISOString()
              })
            }
          }
        }
        if (newRuns.length > 0) {
          allRuns = allRuns.concat(newRuns)
          bundle.verification = allRuns
          decision = this.evaluator.decide({
            rootSpec: input.rootSpec, bundle, fileStates: snapshot.fileStates, changedTurnByFile, turn, hints
          })
          if (decision.decision === 'completed') {
            return this.finish('completed', decision.reason, finalResponse, bundle, continuations, decision)
          }
        }

        const progressed = bundle.turnChangedFiles.length > 0 || newRuns.some((run) => run.outcome === 'passed')
        noProgress = progressed ? 0 : noProgress + 1
        if (noProgress >= this.budget.maxNoProgress) {
          return this.finish('failed', `No progress after ${noProgress} consecutive continuations.`, finalResponse, bundle, continuations, decision)
        }
        prompt = decision.nextPrompt
      }

      if (this.now() - startedAt >= this.budget.maxElapsedMs) {
        return this.finish('budget_exhausted', 'Loop reached the 2 hour wall-clock budget.', finalResponse, bundle, continuations)
      }
      if (continuations >= this.budget.maxContinuations) {
        return this.finish('budget_exhausted', `Loop reached the ${this.budget.maxContinuations} continuation budget.`, finalResponse, bundle, continuations)
      }
      continuations += 1
      if (failure) prompt = continueAfterFailure(input.rootSpec, bundle, failure)
    }
  }

  private withCwd(request: CheckRequest, input: LoopRunInput, turn: number): VerificationRequest {
    return {
      ...request,
      cwd: input.workspacePath,
      turn,
      permission: { preset: input.permission, workspacePath: input.workspacePath }
    }
  }

  private finish(
    status: LoopTerminalSummary['status'],
    reason: string,
    finalResponse: string,
    evidence: EvidenceBundle,
    continuations: number,
    decision?: LoopDecision
  ): LoopRunResult {
    return { terminal: { status, reason }, finalResponse, evidence, continuations, ...(decision ? { decision } : {}) }
  }
}

async function workspaceHints(workspacePath: string): Promise<WorkspaceHints> {
  const hints: WorkspaceHints = { packageJson: false, hasTypecheckScript: false, hasTestScript: false, hasBuildScript: false, tsconfig: false }
  try {
    const manifest = JSON.parse(await readFile(join(workspacePath, 'package.json'), 'utf8'))
    hints.packageJson = true
    const scripts: Record<string, string> = manifest.scripts ?? {}
    hints.hasTypecheckScript = typeof scripts.typecheck === 'string'
    hints.hasTestScript = typeof scripts.test === 'string'
    hints.hasBuildScript = typeof scripts.build === 'string'
  } catch { /* no package.json */ }
  try {
    await readFile(join(workspacePath, 'tsconfig.json'))
    hints.tsconfig = true
  } catch { /* no tsconfig */ }
  return hints
}

function continueAfterFailure(rootSpec: string, evidence: EvidenceBundle, failure: string): string {
  const changed = evidence.changedFiles.slice(0, 10).join(', ') || 'none'
  const lines = [
    'The previous attempt failed. Continue the original task; do not repeat the same error.',
    `Original spec: ${truncate(rootSpec, 1500)}`,
    `Changed files so far: ${changed}`,
    `The previous attempt failed with: ${truncate(failure)}`
  ]
  return lines.join('\n')
}

function truncate(text: string, max = 200): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}
