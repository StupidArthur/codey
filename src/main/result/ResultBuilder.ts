import type { ExecutionOutcome, LoopTerminalSummary, ResultSummary } from '../../shared/contracts'
import type { EvidenceBundle } from '../evidence/EvidenceCollector'

export interface ResultBuildInput {
  finalResponse: string
  evidence: EvidenceBundle
  outcome: ExecutionOutcome
  loopTerminal?: LoopTerminalSummary
}

/**
 * Composes a ResultDocument as a projection of facts, not a summary of the run.
 * Verification lines are taken only from collected evidence; a model sentence
 * claiming a check passed can never create one. Deliberately deterministic so
 * it cannot fabricate verification.
 */
export class ResultBuilder {
  build(input: ResultBuildInput): ResultSummary {
    const changes = input.evidence.changedFiles.slice(0, 20).map((file) =>
      `${file} (${input.evidence.newFiles.includes(file) ? 'created' : 'modified'})`
    )
    const verification = input.evidence.verification
      .filter((claim) => claim.outcome !== 'observed')
      .map((claim) => `${claim.label} — ${claim.outcome}`)

    const terminal = input.loopTerminal
    const completed = input.outcome === 'completed' && (terminal === undefined || terminal.status === 'completed')
    const remaining: string[] = []
    if (!completed) {
      remaining.push(terminal?.reason ?? reasonForOutcome(input.outcome))
      if (verification.length === 0) remaining.push('No verification evidence was collected for this execution.')
    }

    return {
      summary: firstParagraph(input.finalResponse),
      changes,
      verification,
      remaining,
      ...(terminal ? { loopTerminal: terminal } : {}),
      createdAt: new Date().toISOString()
    }
  }
}

function firstParagraph(text: string): string {
  const paragraph = text.split(/\n\s*\n/).map((part) => part.trim()).find(Boolean) ?? ''
  const flat = paragraph.replace(/\s+/g, ' ')
  return flat.length > 600 ? `${flat.slice(0, 597)}…` : flat
}

function reasonForOutcome(outcome: ExecutionOutcome): string {
  switch (outcome) {
    case 'failed': return 'Execution failed before producing a complete result.'
    case 'interrupted': return 'Execution was interrupted before completion.'
    case 'blocked': return 'Execution was blocked and needs input or a missing capability.'
    default: return 'Execution did not complete.'
  }
}
