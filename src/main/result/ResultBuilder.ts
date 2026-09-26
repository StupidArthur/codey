import type { ExecutionOutcome, LoopTerminalSummary, RoundMode, RequirementCoverageSummary, ResultSummary } from '../../shared/contracts'
import type { EvidenceBundle, VerificationRun } from '../evidence/evidence'
import type { LoopDecision } from '../loop/LoopEvaluator'
import type { RequirementCondition } from '../loop/RequiredSpec'

export interface ResultBuildInput {
  finalResponse: string
  evidence: EvidenceBundle
  outcome: ExecutionOutcome
  loopTerminal?: LoopTerminalSummary
  decision?: LoopDecision
  /** The whole work phase the Result summarizes (Plan/Vibe turns, Loop root). */
  round?: {
    mode: RoundMode
    /** Every turn of the round in order: the user's spec and its outcome. */
    turns: Array<{ spec: string; outcome: ExecutionOutcome }>
  }
}

/**
 * Composes a ResultDocument as a projection of facts over the whole round,
 * not a summary of the last reply. Verification lines are taken only from
 * collected evidence (the product's own executor runs); a model sentence
 * claiming a check passed can never create one. `observed`/`unknown` is never
 * shown as passed, stale passes are shown as history instead of current
 * validity, and completion reason and remaining gaps come from the evaluator's
 * actual decision. Deterministic.
 */
export class ResultBuilder {
  build(input: ResultBuildInput): ResultSummary {
    const changes = input.evidence.changedFiles.slice(0, 20).map((file) => describeChange(input.evidence, file))
    if (input.evidence.preexistingChanges?.length > 0) {
      changes.push(`用户执行前已改动（归属保留，未计入本轮）: ${input.evidence.preexistingChanges.slice(0, 10).join(', ')}`)
    }

    const verificationRuns = input.evidence.verification
    const validRunIds = new Set(input.decision?.validRunIds ?? verificationRuns.map((run) => run.id))
    const current = verificationRuns.filter((run) => run.outcome === 'passed' && validRunIds.has(run.id))
    const historical = verificationRuns.filter((run) => run.outcome === 'passed' && !validRunIds.has(run.id))
    const verification = current.map((run) => `${run.label} — ${passedDetail(run)}`)
    for (const run of historical) {
      verification.push(`${run.label} — 历史:曾通过，但其目标此后已变化，不再是当前有效验证`)
    }
    const failed = verificationRuns.filter((run) => run.outcome === 'failed')
    const denied = verificationRuns.filter((run) => run.outcome === 'denied')
    const neverVerified = verificationRuns.length === 0
      ? (input.decision ? [] : ['未运行产品验证（本轮模式不自动执行验证命令）。'])
      : []

    const terminal = input.loopTerminal
    const completed = input.outcome === 'completed' && (terminal === undefined || terminal.status === 'completed')
    const remaining: string[] = []
    if (!completed) {
      if (input.decision?.incomplete.length) {
        remaining.push(...input.decision.incomplete.map((line) => `未覆盖要求: ${line}`))
      } else if (terminal) {
        remaining.push(terminal.reason)
      }
      if (verification.length === 0 && current.length === 0) remaining.push('No verification evidence passed for this execution.')
      for (const line of neverVerified) remaining.push(line)
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
      summary: summarizeRound(input),
      changes,
      verification,
      remaining,
      ...(terminal ? { loopTerminal: terminal } : {}),
      ...(input.decision ? {
        decision: {
          decision: input.decision.decision,
          reason: input.decision.reason,
          incomplete: input.decision.incomplete,
          knownIssues: input.decision.knownIssues,
          validRunIds: input.decision.validRunIds
        }
      } : {}),
      ...(coverage && coverage.length > 0 ? { coverage } : {}),
      createdAt: new Date().toISOString()
    }
  }
}

/** Accurate per-file change description: created / deleted / modified. */
function describeChange(evidence: EvidenceBundle, file: string): string {
  if (evidence.newFiles.includes(file)) return `${file} (created)`
  if (evidence.deletedFiles?.includes(file)) return `${file} (deleted)`
  return `${file} (modified)`
}

/** The summary describes the whole phase — mode, turn count, outcomes and the
 *  latest request — never a mechanical excerpt of the last reply. */
function summarizeRound(input: ResultBuildInput): string {
  const round = input.round
  if (!round || round.turns.length === 0) {
    const lead = firstParagraph(input.finalResponse)
    return lead ? `最近输出摘要: ${lead}` : ''
  }
  const completed = round.turns.filter((turn) => turn.outcome === 'completed').length
  const failedTurns = round.turns.filter((turn) => turn.outcome === 'failed').length
  const blockedTurns = round.turns.filter((turn) => turn.outcome === 'blocked').length
  const modeLabel = round.mode === 'plan' ? 'Plan' : round.mode === 'vibe' ? 'Vibe' : 'Loop'
  const parts = [`${modeLabel} 轮共 ${round.turns.length} 个执行请求`]
  if (round.turns.length > 1) {
    parts.push(`${completed} 成功${failedTurns > 0 ? ` / ${failedTurns} 失败` : ''}${blockedTurns > 0 ? ` / ${blockedTurns} 阻塞` : ''}`)
  }
  const lastSpec = round.turns[round.turns.length - 1]?.spec ?? ''
  parts.push(`最近请求: "${truncateSpec(lastSpec, 60)}"`)
  const changes = input.evidence.changedFiles.length
  if (changes > 0) parts.push(`涉及 ${changes} 个文件的变更`)
  return parts.join('；')
}

function truncateSpec(spec: string, max: number): string {
  const flat = spec.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
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
