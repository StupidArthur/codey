import type { ExecutionOutcome, LoopTerminalSummary, RunnerEvent } from '../../shared/contracts'
import type { DshRuntime } from '../dsh/DshRuntime'
import type { EvidenceBundle, EvidenceCollector, VerificationClaim } from '../evidence/EvidenceCollector'

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
    private readonly budget: LoopBudget = DEFAULT_LOOP_BUDGET,
    /** Wall-clock source; injectable so budget boundaries are testable without waiting. */
    private readonly now: () => number = Date.now
  ) {}

  async run(input: LoopRunInput): Promise<LoopRunResult> {
    const startedAt = this.now()
    const errorCounts = new Map<string, number>()
    let changedSoFar = new Set<string>()
    const accumulatedChanges = new Set<string>()
    const accumulatedNewFiles = new Set<string>()
    const accumulatedVerification: VerificationClaim[] = []
    let noProgress = 0
    let continuations = 0
    let finalResponse = ''
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

      // Accumulate across continuations so the Result reflects every file the
      // loop touched, not only the final turn. Completion decisions below still
      // read the current turn's evidence.
      for (const file of evidence.changedFiles) accumulatedChanges.add(file)
      for (const file of evidence.newFiles) accumulatedNewFiles.add(file)
      for (const claim of evidence.verification) accumulatedVerification.push(claim)
      const cumulative: EvidenceBundle = {
        ...evidence,
        changedFiles: [...accumulatedChanges],
        newFiles: [...accumulatedNewFiles],
        verification: dedupeClaims(accumulatedVerification)
      }

      if (failure) {
        const count = (errorCounts.get(failure) ?? 0) + 1
        errorCounts.set(failure, count)
        if (count >= this.budget.maxSameError) {
          return this.finish('failed', `Same error repeated ${count} times: ${truncate(failure)}`, finalResponse, cumulative, continuations)
        }
      } else {
        finalResponse = text
        const changed = new Set(evidence.changedFiles)
        const progressed = evidence.verification.some((claim) => claim.outcome === 'passed') ||
          [...changed].some((file) => !changedSoFar.has(file))
        changedSoFar = changed
        noProgress = progressed ? 0 : noProgress + 1

        if (BLOCKED.test(text)) {
          return this.finish('blocked', 'The model reported that it needs input or lacks a capability.', finalResponse, cumulative, continuations)
        }
        if (this.complete(text, evidence)) {
          return this.finish('completed', 'Spec requirements are covered by passing verification evidence.', finalResponse, cumulative, continuations)
        }
        if (noProgress >= this.budget.maxNoProgress) {
          return this.finish('failed', `No progress after ${noProgress} consecutive continuations.`, finalResponse, cumulative, continuations)
        }
      }

      if (this.now() - startedAt >= this.budget.maxElapsedMs) {
        return this.finish('budget_exhausted', 'Loop reached the 2 hour wall-clock budget.', finalResponse, cumulative, continuations)
      }
      if (continuations >= this.budget.maxContinuations) {
        return this.finish('budget_exhausted', `Loop reached the ${this.budget.maxContinuations} continuation budget.`, finalResponse, cumulative, continuations)
      }
      continuations += 1
      prompt = continuePrompt(input.rootSpec, cumulative, failure)
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

function dedupeClaims(claims: VerificationClaim[]): VerificationClaim[] {
  const seen = new Set<string>()
  const unique: VerificationClaim[] = []
  for (const claim of claims) {
    const key = `${claim.label}\u0000${claim.outcome}`
    if (seen.has(key)) continue
    seen.add(key)
    unique.push(claim)
  }
  return unique
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
