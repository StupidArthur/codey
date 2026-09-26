import type { ExecutionOutcome, LoopTerminalSummary, RequirementCoverageSummary, ResultSummary } from '../../shared/contracts'
import type { EvidenceBundle, VerificationRun } from '../evidence/evidence'
import type { LoopDecision } from '../loop/LoopEvaluator'
import type { RequirementCondition } from '../loop/RequiredSpec'

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
    const verificationRuns = input.evidence.verification
    const passed = verificationRuns.filter((run) => run.outcome === 'passed')
    const verification = passed.map((run) => `${run.label} — ${passedDetail(run)}`)
    const failed = verificationRuns.filter((run) => run.outcome === 'failed')
    const denied = verificationRuns.filter((run) => run.outcome === 'denied')

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
      for (const run of failed) remaining.push(`${run.label} failed — ${failedDetail(run)}`)
      for (const run of denied) remaining.push(`${run.label} denied — ${run.denial ?? 'executor refused the check'}`)
      if (input.decision?.knownIssues.length) remaining.push(...input.decision.knownIssues.map((issue) => `已知问题: ${issue}`))
    }

    const coverage = input.decision
      ? input.decision.items.map<RequirementCoverageSummary>((item) => ({
          id: item.id,
          original: item.original,
          status: item.status,
          evidenceIds: item.evidenceIds,
          conditions: item.conditions.map((condition) => describeConditionText(condition)),
          ...(item.uncovered && item.uncovered.length > 0 ? { uncovered: item.uncovered } : {}),
          ...(item.note ? { note: item.note } : {})
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

/** Passed verification lines state what was actually verified, never just an
 *  exit code: built-in checks report the fact, shell checks report exit 0. */
function passedDetail(run: VerificationRun): string {
  if (run.method === 'builtin') {
    const fact = run.facts[0]
    if (fact?.kind === 'file-exists') return 'passed (file exists)'
    if (fact?.kind === 'content-equals') return `passed (content match, sha1 ${fact.actualHash ?? 'n/a'})`
    if (fact?.kind === 'field-equals') return `passed (field '${fact.key}' = '${fact.expected}')`
  }
  return `passed (exit ${run.exitCode ?? 'n/a'})`
}

function failedDetail(run: VerificationRun): string {
  if (run.method === 'builtin') return run.outputTail || 'check did not pass'
  return `exit ${run.exitCode ?? 'n/a'}${run.outputTail ? ` — ${run.outputTail}` : ''}`
}

/** Human-readable form of one parsed acceptance condition. */
function describeConditionText(condition: RequirementCondition): string {
  switch (condition.kind) {
    case 'file': return `file exists as a regular file: ${condition.target}`
    case 'content': return `content of ${condition.target} matches the required text`
    case 'field': return `field ${condition.key} of ${condition.target} equals '${condition.expected}'`
    case 'command': return `acceptance command exits 0: ${condition.expected}`
    case 'tests': return 'tests pass'
    case 'typecheck': return 'typecheck passes'
    case 'build': return 'build passes'
  }
}
