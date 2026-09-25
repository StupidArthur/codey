import type { ExecutionOutcome, LoopTerminalSummary, RunnerEvent } from '../../shared/contracts'
import type { DshRuntime } from '../dsh/DshRuntime'
import type { EvidenceBundle, EvidenceCollector } from '../evidence/EvidenceCollector'

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
  takeEvents: () => RunnerEvent[]
}

export interface LoopRunResult {
  terminal: LoopTerminalSummary
  finalResponse: string
  evidence: EvidenceBundle
  continuations: number
}

const BLOCKED = /blocked|need(?:s|ed)? (?:your |user )?(?:input|approval|permission|decision)|cannot proceed|unable to continue/i

/**
 * Evidence-gated loop. Completion is never taken from the model's own claim:
 * a turn may only complete when real verification evidence passed, the
 * response does not report a block, and there is no unresolved error. The
 * remaining gaps become the next continuation prompt. Budgets stop the loop.
 */
export class LoopController {
  constructor(
    private readonly runtime: DshRuntime,
    private readonly collector: EvidenceCollector,
    private readonly budget: LoopBudget = DEFAULT_LOOP_BUDGET
  ) {}

  async run(input: LoopRunInput): Promise<LoopRunResult> {
    const startedAt = Date.now()
    const errorCounts = new Map<string, number>()
    let changedSoFar = new Set<string>()
    let noProgress = 0
    let continuations = 0
    let finalResponse = ''
    let lastEvidence: EvidenceBundle = emptyBundle('completed')
    let prompt = input.rootSpec

    for (;;) {
      const baseline = await this.collector.baseline(input.workspacePath)
      let failure: string | undefined
      let text = ''
      try {
        text = (await this.runtime.prompt(prompt)).text
      } catch (error) {
        failure = error instanceof Error ? error.message : String(error)
      }
      const outcome: ExecutionOutcome = failure ? 'failed' : 'completed'
      const events = input.takeEvents()
      const evidence = await this.collector.collect(input.workspacePath, baseline, events, outcome)
      lastEvidence = evidence

      if (failure) {
        const count = (errorCounts.get(failure) ?? 0) + 1
        errorCounts.set(failure, count)
        if (count >= this.budget.maxSameError) {
          return this.finish('failed', `Same error repeated ${count} times: ${truncate(failure)}`, finalResponse, evidence, continuations)
        }
      } else {
        finalResponse = text
        const changed = new Set(evidence.changedFiles)
        const progressed = evidence.verification.some((claim) => claim.outcome === 'passed') ||
          [...changed].some((file) => !changedSoFar.has(file))
        changedSoFar = changed
        noProgress = progressed ? 0 : noProgress + 1

        if (BLOCKED.test(text)) {
          return this.finish('blocked', 'The model reported that it needs input or lacks a capability.', finalResponse, evidence, continuations)
        }
        if (this.complete(text, evidence)) {
          return this.finish('completed', 'Spec requirements are covered by passing verification evidence.', finalResponse, evidence, continuations)
        }
        if (noProgress >= this.budget.maxNoProgress) {
          return this.finish('failed', `No progress after ${noProgress} consecutive continuations.`, finalResponse, evidence, continuations)
        }
      }

      if (Date.now() - startedAt >= this.budget.maxElapsedMs) {
        return this.finish('budget_exhausted', 'Loop reached the 2 hour wall-clock budget.', finalResponse, evidence, continuations)
      }
      if (continuations >= this.budget.maxContinuations) {
        return this.finish('budget_exhausted', `Loop reached the ${this.budget.maxContinuations} continuation budget.`, finalResponse, evidence, continuations)
      }
      continuations += 1
      prompt = continuePrompt(input.rootSpec, evidence, failure)
    }
  }

  private complete(text: string, evidence: EvidenceBundle): boolean {
    if (evidence.verification.length === 0) return false
    if (!evidence.verification.some((claim) => claim.outcome === 'passed')) return false
    return evidence.verification.every((claim) => claim.outcome !== 'failed') && !/not (?:done|complete|finished)|still (?:need|missing)/i.test(text)
  }

  private finish(
    status: LoopTerminalSummary['status'],
    reason: string,
    finalResponse: string,
    evidence: EvidenceBundle,
    continuations: number
  ): LoopRunResult {
    return { terminal: { status, reason }, finalResponse, evidence, continuations }
  }
}

function continuePrompt(rootSpec: string, evidence: EvidenceBundle, failure?: string): string {
  const changed = evidence.changedFiles.slice(0, 10).join(', ') || 'none'
  const verified = evidence.verification.map((claim) => `${claim.label} (${claim.outcome})`).join('; ') || 'none'
  const lines = [
    'Continue the original task. Do not restate the whole plan; make the remaining change and verify it.',
    `Original spec: ${truncate(rootSpec, 1500)}`,
    `Changed files so far: ${changed}`,
    `Verification so far: ${verified}`
  ]
  if (failure) lines.push(`The previous attempt failed with: ${truncate(failure)}`)
  lines.push('If the task is complete, run the relevant verification and say "done". If something is truly blocking, say "blocked" and what you need.')
  return lines.join('\n')
}

function truncate(text: string, max = 200): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

function emptyBundle(outcome: ExecutionOutcome): EvidenceBundle {
  return { changedFiles: [], newFiles: [], verification: [], outcome }
}
