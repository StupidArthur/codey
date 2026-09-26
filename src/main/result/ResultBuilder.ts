import type { ExecutionOutcome, LoopTerminalSummary, RequirementCoverageSummary, ResultSummary } from '../../shared/contracts'
import type { EvidenceBundle } from '../evidence/evidence'
import type { LoopDecision } from '../loop/LoopEvaluator'

export interface ResultBuildInput {
  finalResponse: string
  evidence: EvidenceBundle
  outcome: ExecutionOutcome
  loopTerminal?: LoopTerminalSummary
  decision?: LoopDecision
}

/**
 * Composes a ResultDocument as a projection of facts, not a summary of the run.
 * Verification lines are taken only from collected evidence (the product's own
 * executor runs); a model sentence claiming a check passed can never create
 * one. `observed`/`unknown` is never shown as passed, and completion reason and
 * remaining gaps come from the evaluator's actual coverage. Deterministic.
 */
export class ResultBuilder {
  build(input: ResultBuildInput): ResultSummary {
    const changes = input.evidence.changedFiles.slice(0, 20).map((file) =>
      `${file} (${input.evidence.newFiles.includes(file) ? 'created' : 'modified'})`
    )
    const passed = input.evidence.verification.filter((run) => run.outcome === 'passed')
    const verification = passed.map((run) => `${run.label} — passed (exit ${run.exitCode ?? 'n/a'})`)
    const failed = input.evidence.verification.filter((run) => run.outcome === 'failed')

    const terminal = input.loopTerminal
    const completed = input.outcome === 'completed' && (terminal === undefined || terminal.status === 'completed')
    const remaining: string[] = []
    if (!completed) {
      if (input.decision?.incomplete.length) {
        remaining.push(...input.decision.incomplete.map((line) => `未覆盖要求: ${line}`))
      } else if (terminal) {
        remaining.push(terminal.reason)
      }
      if (verification.length === 0 && passed.length === 0) remaining.push('No verification evidence passed for this execution.')
      for (const run of failed) remaining.push(`${run.label} failed (exit ${run.exitCode ?? 'n/a'})`)
      if (input.decision?.knownIssues.length) remaining.push(...input.decision.knownIssues.map((issue) => `已知问题: ${issue}`))
    }

    const coverage = input.decision
      ? input.decision.items.map<RequirementCoverageSummary>((item) => ({
          id: item.id,
          original: item.original,
          status: item.status,
          evidenceIds: item.evidenceIds
        }))
      : undefined

    return {
      summary: firstParagraph(input.finalResponse),
      changes,
      verification,
      remaining,
      ...(terminal ? { loopTerminal: terminal } : {}),
      ...(coverage && coverage.length > 0 ? { coverage } : {}),
      createdAt: new Date().toISOString()
    }
  }
}

function firstParagraph(text: string): string {
  const paragraph = text.split(/\n\s*\n/).map((part) => part.trim())[0] ?? ''
  return paragraph.length > 400 ? `${paragraph.slice(0, 399)}…` : paragraph
}
