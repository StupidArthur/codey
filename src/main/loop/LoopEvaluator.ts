import type { CheckFact } from '../../shared/contracts'
import type { CheckMethod, EvidenceBundle, FileStateMap, VerificationRequest, VerificationRun } from '../evidence/evidence'
import { describeMethod } from '../evidence/VerificationExecutor'
import { extractRequirements, type RequiredItem } from './RequiredSpec'

export interface WorkspaceHints {
  packageJson: boolean
  hasTypecheckScript: boolean
  hasTestScript: boolean
  hasBuildScript: boolean
  tsconfig: boolean
}

export const EMPTY_HINTS: WorkspaceHints = {
  packageJson: false,
  hasTypecheckScript: false,
  hasTestScript: false,
  hasBuildScript: false,
  tsconfig: false
}

export interface DecideInput {
  rootSpec: string
  bundle: EvidenceBundle
  fileStates: FileStateMap
  /** relative file → the turn in which it last changed. */
  changedTurnByFile: Map<string, number>
  turn: number
  hints?: WorkspaceHints
}

/** A verification the loop should run next (controller fills cwd/turn/permission). */
export type CheckRequest = Omit<VerificationRequest, 'cwd' | 'turn' | 'timeoutMs' | 'permission'>

export interface LoopDecision {
  decision: 'completed' | 'continue' | 'blocked' | 'failed'
  reason: string
  items: RequiredItem[]
  incomplete: string[]
  knownIssues: string[]
  nextPrompt: string
  nextChecks: CheckRequest[]
}

const TEST = /\btests?\b|\bspecs?\b|测试|单测/i
const TYPECHECK = /typecheck|\btsc\b|类型检查/i
const BUILD = /\bbuild\b|构建|编译/i

/** Script commands resolved from the workspace manifest, used for both check
 *  suggestions and assessment (a fact only counts for the command it ran). */
export function resolveScriptCommand(kind: 'tests' | 'typecheck' | 'build', hints: WorkspaceHints): string | undefined {
  switch (kind) {
    case 'tests': return hints.hasTestScript ? 'npm test' : undefined
    case 'typecheck': return hints.hasTypecheckScript ? 'npm run typecheck' : hints.tsconfig ? 'npx tsc --noEmit' : undefined
    case 'build': return hints.hasBuildScript ? 'npm run build' : undefined
  }
}

/**
 * The four-condition completion gate, with check facts and requirement
 * assessment kept strictly apart:
 *
 * 1. Check facts — what the product's executor actually verified (file exists
 *    and is a file, content matches, field matches, command exited 0),
 *    recorded by the executor itself. A generator never declares coverage.
 * 2. Requirement assessment — whether those facts cover every objective
 *    condition of a requirement. Only then is the item `satisfied`.
 *
 * Completion additionally requires valid (not invalidated) and relevant
 * evidence, and no known counter-evidence (failed checks not cleared by a
 * re-test of the same check object, failed tools, permission denials,
 * artifacts modified after their check). Requirements without any objective
 * check method stay `unknown` — they are never satisfied by guessing.
 */
export class LoopEvaluator {
  decide(input: DecideInput): LoopDecision {
    const { bundle, rootSpec, fileStates, changedTurnByFile, turn, hints } = input
    const resolvedHints = hints ?? EMPTY_HINTS
    const items = extractRequirements(rootSpec)
    const knownIssues: string[] = []
    const validByRun = new Map<string, boolean>()
    const changedSet = new Set(bundle.changedFiles)
    const failedTools = unresolvedToolFailures(bundle.toolFacts)

    // 1. Validity: a run is void if any target changed, disappeared, or its
    //    content hash no longer matches (same size, same mtime edits).
    for (const run of bundle.verification) {
      validByRun.set(run.id, runValid(run, fileStates, changedTurnByFile))
    }
    const validRelevantRuns = bundle.verification.filter(
      (run) => validByRun.get(run.id) && relevant(run, changedSet)
    )

    // 2. Per-item assessment: every objective condition must be covered by the
    //    latest valid fact of the right kind — never by a generator claim.
    for (const item of items) {
      this.assessItem(item, validRelevantRuns, resolvedHints)
    }

    // 3. Counter-evidence that can overturn a completion.
    for (const run of bundle.verification) {
      if (!validByRun.get(run.id)) {
        knownIssues.push(`${run.label} was invalidated (its targets changed or an artifact disappeared after the check)`)
      }
    }
    for (const run of bundle.verification) {
      if (validByRun.get(run.id) && run.outcome === 'failed' && !clearedByRetest(run, bundle.verification, validByRun)) {
        knownIssues.push(describeFailure(run))
      }
    }
    for (const run of bundle.verification) {
      if (run.outcome === 'denied') knownIssues.push(`${run.label} denied: ${run.denial ?? 'executor refused the check'}`)
    }
    if (failedTools.length > 0) knownIssues.push(...failedTools)
    if (bundle.changedFiles.length === 0 && bundle.turnChangedFiles.length === 0 && bundle.verification.length === 0) {
      knownIssues.push('no files changed and no verification ran this turn')
    }

    // 4. The gate: all items satisfied by real evidence, no counter-evidence.
    const allSatisfied = items.length > 0 && items.every((item) => item.status === 'satisfied')
    const clean = knownIssues.length === 0
    if (allSatisfied && clean) {
      const reason = `Spec requirements are covered by valid verification evidence: ${items.map((item) => `${item.id} (${item.evidenceIds.join(',')})`).join('; ')}.`
      return {
        decision: 'completed',
        reason,
        items,
        incomplete: [],
        knownIssues: [],
        nextPrompt: '',
        nextChecks: []
      }
    }

    const incomplete = items
      .filter((item) => item.status !== 'satisfied')
      .map((item) => `${item.id}: ${item.original} (${item.status}${item.note ? ` — ${item.note}` : ''})`)

    const nextChecks = this.suggestChecks(items, validRelevantRuns, bundle, resolvedHints)

    return {
      decision: 'continue',
      reason: incomplete.length > 0 ? `${incomplete.length} required item(s) not covered by valid evidence.` : 'known workspace issues remain.',
      items,
      incomplete,
      knownIssues: dedupe(knownIssues),
      nextPrompt: buildNextPrompt(rootSpec, incomplete, dedupe(knownIssues)),
      nextChecks
    }
  }

  /**
   * Assess one requirement against valid check facts. The item is satisfied
   * only when every parsed condition is covered by the latest valid fact of
   * the matching kind; unresolved or unverifiable parts keep the item open.
   */
  private assessItem(item: RequiredItem, validRuns: VerificationRun[], hints: WorkspaceHints): void {
    if (item.subjective) {
      item.status = 'unknown'
      item.note = 'no objective acceptance condition could be parsed from this requirement; it stays unknown instead of being satisfied by a guess'
      return
    }

    const evidenceIds = new Set<string>()
    const uncovered: string[] = []
    const unresolvable: string[] = []

    for (const condition of item.conditions) {
      const method = checkMethodFor(condition, hints)
      if (!method) {
        unresolvable.push(describeCondition(condition, hints))
        continue
      }
      const latest = latestFactFor(condition, method, validRuns)
      if (latest && latest.fact.matched) {
        evidenceIds.add(latest.run.id)
        continue
      }
      if (latest) {
        uncovered.push(`${describeCondition(condition, hints)} — latest check did not pass (${latest.run.label})`)
      } else {
        uncovered.push(`${describeCondition(condition, hints)} — no valid passing check yet`)
      }
    }

    if (unresolvable.length > 0) {
      item.status = 'unknown'
      item.evidenceIds = [...evidenceIds]
      item.note = `no automatic check method for: ${unresolvable.join('; ')}`
      return
    }
    if (uncovered.length === 0) {
      item.status = 'satisfied'
      item.evidenceIds = [...evidenceIds]
      item.note = undefined
      return
    }
    item.status = 'pending'
    item.evidenceIds = [...evidenceIds]
    item.uncovered = uncovered
    item.note = uncovered.join('; ')
  }

  /**
   * Deterministic check selection for UNCOVERED conditions only — an already
   * satisfied condition is never re-checked (a repeated passing check must not
   * count as loop progress). Built-in conditions use the path-constrained
   * read-only executor; explicit `Run:` commands and repository scripts map to
   * shell checks (the executor enforces the session permission and refuses
   * what it cannot confine). There is no fallback that lets an arbitrary
   * changed file stand in for a functional requirement.
   */
  suggestChecks(items: RequiredItem[], validRuns: VerificationRun[], bundle: EvidenceBundle, hints: WorkspaceHints): CheckRequest[] {
    const requests: CheckRequest[] = []
    const changed = bundle.changedFiles
    for (const item of items) {
      if (item.status === 'satisfied') continue
      for (const condition of item.conditions) {
        if (conditionSatisfied(condition, validRuns, hints)) continue
        const method = checkMethodFor(condition, hints)
        if (!method) continue
        const targets = method.kind === 'shell' ? changed : [condition.target!]
        requests.push({
          label: checkLabel(condition, item.id),
          method,
          scope: method.kind === 'shell' ? 'workspace' : 'file',
          targets
        })
      }
    }
    return dedupeChecks(requests)
  }
}

function conditionSatisfied(condition: RequiredItem['conditions'][number], validRuns: VerificationRun[], hints: WorkspaceHints): boolean {
  const method = checkMethodFor(condition, hints)
  if (!method) return false
  const latest = latestFactFor(condition, method, validRuns)
  return Boolean(latest && latest.fact.matched)
}

function checkMethodFor(condition: RequiredItem['conditions'][number], hints: WorkspaceHints): CheckMethod | undefined {
  switch (condition.kind) {
    case 'file': return { kind: 'file-exists', target: condition.target! }
    case 'content': return { kind: 'content-equals', target: condition.target!, expected: condition.expected! }
    case 'field': return condition.target!.toLowerCase().endsWith('.json')
      ? { kind: 'field-equals', target: condition.target!, key: condition.key!, expected: condition.expected! }
      : undefined
    case 'command': return { kind: 'shell', command: 'cmd', args: ['/c', condition.expected!] }
    case 'tests':
    case 'typecheck':
    case 'build': {
      const script = resolveScriptCommand(condition.kind, hints)
      return script ? { kind: 'shell', command: 'cmd', args: ['/c', script] } : undefined
    }
  }
}

function describeCondition(condition: RequiredItem['conditions'][number], hints: WorkspaceHints): string {
  switch (condition.kind) {
    case 'file': return `file exists as a regular file: ${condition.target}`
    case 'content': return `content of ${condition.target} matches the required text`
    case 'field': return `field ${condition.key} of ${condition.target} equals '${condition.expected}'`
    case 'command': return `acceptance command exits 0: ${condition.expected}`
    case 'tests': {
      const script = resolveScriptCommand('tests', hints)
      return script ? `tests pass (${script})` : 'tests pass (no test script found in the workspace)'
    }
    case 'typecheck': {
      const script = resolveScriptCommand('typecheck', hints)
      return script ? `typecheck passes (${script})` : 'typecheck passes (no typecheck script or tsconfig found)'
    }
    case 'build': {
      const script = resolveScriptCommand('build', hints)
      return script ? `build passes (${script})` : 'build passes (no build script found in the workspace)'
    }
  }
}

function checkLabel(condition: RequiredItem['conditions'][number], itemId: string): string {
  switch (condition.kind) {
    case 'file': return `artifact ${itemId}`
    case 'content': return `content ${itemId}`
    case 'field': return `field ${itemId}`
    case 'command': return `verify ${itemId}`
    case 'tests': return 'tests'
    case 'typecheck': return 'typecheck'
    case 'build': return 'build'
  }
}

interface FactMatch {
  fact: CheckFact
  run: VerificationRun
}

/** The latest valid fact that matches this condition's kind and target. Runs
 *  are evaluated in append (chronological) order; the last match wins. */
function latestFactFor(condition: RequiredItem['conditions'][number], method: CheckMethod, runs: VerificationRun[]): FactMatch | undefined {
  let best: FactMatch | undefined
  for (const run of runs) {
    for (const fact of run.facts) {
      if (factMatches(fact, condition, method)) best = { fact, run }
    }
  }
  return best
}

function factMatches(fact: CheckFact, condition: RequiredItem['conditions'][number], method: CheckMethod): boolean {
  switch (condition.kind) {
    case 'file': return fact.kind === 'file-exists' && fact.target === condition.target
    case 'content': return fact.kind === 'content-equals' && fact.target === condition.target
    case 'field': return fact.kind === 'field-equals' && fact.target === condition.target && fact.key === condition.key
    case 'command': return fact.kind === 'command-exit' && fact.command === commandLineOf(method)
    case 'tests':
    case 'typecheck':
    case 'build': return fact.kind === 'command-exit' && fact.command === commandLineOf(method)
  }
}

function commandLineOf(method: CheckMethod): string {
  if (method.kind !== 'shell') return describeMethod(method)
  const joined = [method.command, ...method.args].join(' ').replace(/\s+/g, ' ').trim()
  return joined.slice(0, 500)
}

function runValid(run: VerificationRun, fileStates: FileStateMap, changedTurnByFile: Map<string, number>): boolean {
  for (const target of run.targets) {
    const current = fileStates.get(target)
    const atRun = run.stamps.get(target)
    if (current === undefined || !current.exists) return false
    if (atRun === undefined || !atRun.exists) return false
    if (current.mtimeMs !== atRun.mtimeMs || current.size !== atRun.size) return false
    if (atRun.hash && current.hash && atRun.hash !== current.hash) return false
    if ((changedTurnByFile.get(target) ?? 0) > run.turn) return false
  }
  return true
}

function relevant(run: VerificationRun, changedSet: Set<string>): boolean {
  if (run.scope === 'workspace') return changedSet.size > 0
  return run.targets.some((target) => changedSet.has(target))
}

/** An old failed check is only cleared by a valid passing re-test of the same
 *  check object (same method, same command, same targets) that ran AFTER it —
 *  never by an unrelated later success. Order is the chronological append
 *  order of the run array. */
function clearedByRetest(failedRun: VerificationRun, allRuns: VerificationRun[], validByRun: Map<string, boolean>): boolean {
  const failedIndex = allRuns.indexOf(failedRun)
  return allRuns.some((other, index) =>
    index > failedIndex
    && other.outcome === 'passed'
    && validByRun.get(other.id)
    && other.method === failedRun.method
    && other.command === failedRun.command
    && sameTargets(other.targets, failedRun.targets)
  )
}

function sameTargets(a: string[], b: string[]): boolean {
  return a.length === b.length && [...a].sort().join('\u0000') === [...b].sort().join('\u0000')
}

function describeFailure(run: VerificationRun): string {
  const detail = run.method === 'builtin'
    ? (run.facts.find((fact) => !fact.matched) ? factFailureDetail(run) : '')
    : ` (exit ${run.exitCode ?? 'n/a'})`
  return `${run.label} failed${detail}`
}

function factFailureDetail(run: VerificationRun): string {
  const fact = run.facts.find((item) => !item.matched)
  if (!fact) return ''
  if (fact.kind === 'file-exists') return fact.isFile ? '' : ' (path exists but is not a regular file)'
  if (fact.kind === 'content-equals') return ' (content mismatch)'
  if (fact.kind === 'field-equals') return ` (field '${fact.key}' is ${fact.actual === null ? 'missing' : `'${fact.actual}'`}, expected '${fact.expected}')`
  return ''
}

function unresolvedToolFailures(toolFacts: EvidenceBundle['toolFacts']): string[] {
  const issues: string[] = []
  for (const fact of toolFacts) {
    if (fact.status !== 'failed') continue
    const recovered = toolFacts.some(
      (other) => other.toolCallId !== fact.toolCallId && other.title === fact.title && other.status === 'completed' && other.at >= fact.at
    )
    if (!recovered) issues.push(`DSH tool "${fact.title}" failed this turn`)
  }
  return issues
}

function buildNextPrompt(rootSpec: string, incomplete: string[], knownIssues: string[]): string {
  const lines: string[] = []
  if (incomplete.length > 0) {
    lines.push('The task is not complete. The following required items still lack valid, passing verification evidence:')
    for (const line of incomplete) lines.push(`- ${truncate(line, 400)}`)
  }
  if (knownIssues.length > 0) {
    lines.push('Known workspace issues to resolve before the task can complete:')
    for (const issue of knownIssues) lines.push(`- ${truncate(issue, 400)}`)
  }
  lines.push(`Original spec: ${truncate(rootSpec, 2000)}`)
  lines.push('Fix the incomplete items and run the relevant verification. When the task is genuinely blocked and needs user input, start your reply with exactly [BLOCKED].')
  return lines.join('\n')
}

function dedupe(values: string[]): string[] {
  return [...new Set(values)]
}

function dedupeChecks(requests: CheckRequest[]): CheckRequest[] {
  const seen = new Set<string>()
  const unique: CheckRequest[] = []
  for (const request of requests) {
    const key = `${request.label}\u0000${describeMethod(request.method)}`
    if (seen.has(key)) continue
    seen.add(key)
    unique.push(request)
  }
  return unique
}

function truncate(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}
