import type { CheckFact, PermissionPreset } from '../../shared/contracts'
import type { CheckMethod, EvidenceBundle, FileStateMap, VerificationRequest, VerificationRun } from '../evidence/evidence'
import { describeMethod } from '../evidence/VerificationExecutor'
import { extractRequirements, type RequiredItem } from './RequiredSpec'
import { buildInventory, type EvidenceInventoryEntry, type ModelDecisionShape } from './ModelDecision'

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

/** Workspace directory for sandbox verification artifacts (never dotted: the
 *  collector must track these files for validity stamping). */
export const VERIFY_DIR = 'temporal-verify'

export interface DecideInput {
  rootSpec: string
  bundle: EvidenceBundle
  fileStates: FileStateMap
  /** relative file → the turn in which it last changed. */
  changedTurnByFile: Map<string, number>
  turn: number
  hints?: WorkspaceHints
  /** The session permission preset — decides which check methods may run. */
  permission: PermissionPreset
  /** The model's structured decision for this turn (validated by the caller). */
  modelDecision?: ModelDecisionShape
  /** Why the model's decision was absent or malformed (its reply still counts as incomplete). */
  decisionError?: string
}

/** A verification the loop should run next (controller fills cwd/turn/permission). */
export type CheckRequest = Omit<VerificationRequest, 'cwd' | 'turn' | 'timeoutMs' | 'permission'>

/** A verification script the loop materializes so the model can run it inside
 *  DSH's sandbox; the product then reads the artifacts with its own executor. */
export interface SandboxScript {
  /** File name inside VERIFY_DIR (e.g. tests.cmd). */
  name: string
  /** The exact command the model is told to run. */
  command: string
  content: string
}

export interface LoopDecision {
  decision: 'completed' | 'continue' | 'blocked' | 'failed'
  reason: string
  items: RequiredItem[]
  incomplete: string[]
  knownIssues: string[]
  nextPrompt: string
  nextChecks: CheckRequest[]
  sandboxScripts: SandboxScript[]
  /** Runs whose passes are currently valid; the Result marks the rest historical. */
  validRunIds: string[]
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
    const { bundle, rootSpec, fileStates, changedTurnByFile, turn, hints, modelDecision, decisionError } = input
    const resolvedHints = hints ?? EMPTY_HINTS
    const items = extractRequirements(rootSpec)
    const knownIssues: string[] = []
    const validByRun = new Map<string, boolean>()
    const relevantByRun = new Map<string, boolean>()
    const changedSet = new Set(bundle.changedFiles)
    const failedTools = unresolvedToolFailures(bundle.toolFacts)

    // 1. Validity: a run is void if any target changed, disappeared, or its
    //    content hash no longer matches (same size, same mtime edits).
    for (const run of bundle.verification) {
      const valid = runValid(run, fileStates, changedTurnByFile)
      validByRun.set(run.id, valid)
      relevantByRun.set(run.id, relevant(run, changedSet))
    }
    const validRelevantRuns = bundle.verification.filter(
      (run) => validByRun.get(run.id) && relevantByRun.get(run.id)
    )

    // 2. Objective assessment (display + check suggestions — the completion
    //    authority is the model's assessment, validated below).
    for (const item of items) {
      this.assessItem(item, validRelevantRuns, resolvedHints, input.permission)
    }

    // 3. Counter-evidence that can overturn a completion. A stale run only
    //    matters while it is the latest run of its check object: a later
    //    re-check (any outcome) supersedes it, otherwise re-running the model's
    //    own wrapper would poison the loop with permanent counter-evidence.
    for (const run of bundle.verification) {
      if (!validByRun.get(run.id) && !supersededByLaterRun(run, bundle.verification)) {
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

    const inventory = buildInventory(bundle.verification, validByRun, relevantByRun, bundle.changedFiles, fileStates)
    const incomplete = items
      .filter((item) => item.status !== 'satisfied')
      .map((item) => `${item.id}: ${item.original} (${item.status}${item.note ? ` — ${item.note}` : ''})`)

    // Check selection happens before the completion gate: the gate needs to
    // know whether the product has a runnable check a citation must anchor.
    const nextChecks = this.suggestChecks(items, validRelevantRuns, bundle, resolvedHints, input.permission)
    const sandboxScripts = sandboxScriptsFor(nextChecks, resolvedHints, input.permission)

    // 4. The model's decision, validated by the product. Semantic coverage is
    //    the model's call; citations, evidence existence/validity, obvious
    //    contradictions and budget-adjacent facts are the product's.
    if (modelDecision?.decision === 'blocked') {
      return {
        decision: 'blocked',
        reason: modelDecision.reason || 'The model reported that it needs user input to continue.',
        items,
        incomplete: dedupe([...incomplete, ...modelDecision.incomplete.map((line) => `model: ${line}`)]),
        knownIssues: dedupe(knownIssues),
        nextPrompt: '',
        // The controller runs these before finalizing the blocked terminal so
        // Remaining names what actually passed and what is missing.
        nextChecks,
        sandboxScripts,
        validRunIds: [...validByRun.entries()].filter(([, valid]) => valid).map(([id]) => id)
      }
    }

    let rejectedCompletion = false
    if (modelDecision?.decision === 'completed') {
      const rejection = validateCompletion(modelDecision, inventory, knownIssues, nextChecks.length)
      if (rejection.length === 0) {
        const cited = [...new Set(modelDecision.coverage.flatMap((entry) => entry.evidence))]
        // Accept the model's semantic coverage; annotate items the objective
        // machinery could not verify on its own.
        for (const item of items) {
          if (item.status !== 'satisfied') {
            item.status = 'satisfied'
            item.note = cited.length > 0
              ? `accepted by model assessment, cited evidence: ${cited.join(', ')}`
              : 'accepted by model assessment (no evidence cited)'
            item.uncovered = undefined
          }
        }
        return {
          decision: 'completed',
          reason: `Model assessed the spec as complete and the product validated the citations: ${truncate(modelDecision.reason, 300)} (cited: ${cited.join(', ') || 'none'}).`,
          items,
          incomplete: [],
          knownIssues: [],
          nextPrompt: '',
          nextChecks: [],
          sandboxScripts: [],
          validRunIds: [...validByRun.entries()].filter(([, valid]) => valid).map(([id]) => id)
        }
      }
      knownIssues.push(...rejection)
      rejectedCompletion = true
    }

    if (decisionError) {
      knownIssues.push(`the model's reply had no usable decision block (${decisionError}); the turn counts as incomplete`)
    }

    return {
      decision: 'continue',
      reason: incomplete.length > 0 ? `${incomplete.length} required item(s) not covered by valid evidence.` : 'known workspace issues remain.',
      items,
      incomplete,
      knownIssues: dedupe(knownIssues),
      nextPrompt: buildNextPrompt(rootSpec, incomplete, dedupe(knownIssues), inventory, modelDecision, sandboxScripts, rejectedCompletion === true),
      nextChecks,
      sandboxScripts,
      validRunIds: [...validByRun.entries()].filter(([, valid]) => valid).map(([id]) => id)
    }
  }

  /**
   * Assess one requirement against valid check facts. The item is satisfied
   * only when every parsed condition is covered by the latest valid fact of
   * the matching kind; unresolved or unverifiable parts keep the item open.
   * Under `workspace-write`, repository script conditions (tests/typecheck/
   * build) are checked through sandbox artifacts instead of a refused shell.
   */
  private assessItem(item: RequiredItem, validRuns: VerificationRun[], hints: WorkspaceHints, permission: PermissionPreset): void {
    if (item.subjective) {
      item.status = 'unknown'
      item.note = 'no objective acceptance condition could be parsed from this requirement; it stays unknown instead of being satisfied by a guess'
      return
    }

    const evidenceIds = new Set<string>()
    const uncovered: string[] = []
    const unresolvable: string[] = []

    for (const condition of item.conditions) {
      const method = checkMethodFor(condition, hints, permission)
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
   * read-only executor. Shell-bound conditions follow the session permission:
   * `danger-full-access` runs the command directly (the executor still
   * enforces that preset); `workspace-write` verifies repository scripts
   * through sandbox artifacts the model produces inside DSH's own confined
   * execution; `read-only` has no method. There is no fallback that lets an
   * arbitrary changed file stand in for a functional requirement.
   */
  suggestChecks(items: RequiredItem[], validRuns: VerificationRun[], bundle: EvidenceBundle, hints: WorkspaceHints, permission: PermissionPreset): CheckRequest[] {
    const requests: CheckRequest[] = []
    const changed = bundle.changedFiles
    for (const item of items) {
      if (item.status === 'satisfied') continue
      for (const condition of item.conditions) {
        if (conditionSatisfied(condition, validRuns, hints, permission)) continue
        const method = checkMethodFor(condition, hints, permission)
        if (!method) continue
        const targets = method.kind === 'shell' ? changed : method.kind === 'content-equals' && isSandboxExitTarget(condition, method.target) ? [method.target, sandboxLogTarget(condition)] : [condition.target!]
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

function isSandboxExitTarget(condition: RequiredItem['conditions'][number], target: string): boolean {
  return isScriptKind(condition.kind) && target === sandboxExitTarget(condition.kind)
}

/** True for condition kinds that map to repository scripts. */
function isScriptKind(kind: RequiredItem['conditions'][number]['kind']): kind is 'tests' | 'typecheck' | 'build' {
  return kind === 'tests' || kind === 'typecheck' || kind === 'build'
}

/** The sandbox artifact that carries the script's real exit code. */
export function sandboxExitTarget(kind: 'tests' | 'typecheck' | 'build'): string {
  return `${VERIFY_DIR}/${kind}.exit`
}

function sandboxLogTarget(condition: RequiredItem['conditions'][number]): string {
  return `${VERIFY_DIR}/${condition.kind}.log`
}

function conditionSatisfied(condition: RequiredItem['conditions'][number], validRuns: VerificationRun[], hints: WorkspaceHints, permission: PermissionPreset): boolean {
  const method = checkMethodFor(condition, hints, permission)
  if (!method) return false
  const latest = latestFactFor(condition, method, validRuns)
  return Boolean(latest && latest.fact.matched)
}

function checkMethodFor(condition: RequiredItem['conditions'][number], hints: WorkspaceHints, permission: PermissionPreset): CheckMethod | undefined {
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
      if (!script) return undefined
      if (permission === 'danger-full-access') {
        return { kind: 'shell', command: 'cmd', args: ['/c', script] }
      }
      if (permission === 'workspace-write') {
        // The command runs inside DSH's confined sandbox (driven by the
        // model); the product verifies the produced exit artifact itself.
        return { kind: 'content-equals', target: sandboxExitTarget(condition.kind), expected: '0' }
      }
      return undefined
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
 *  are evaluated in append (chronological) order; the last match wins. Script
 *  conditions match either a direct command-exit fact (full access) or the
 *  sandbox exit artifact (workspace-write). */
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
    case 'build': {
      if (method.kind === 'shell') return fact.kind === 'command-exit' && fact.command === commandLineOf(method)
      // Sandbox path: the fact is the product's own content check on the exit
      // artifact; the same condition name keeps the check object stable so a
      // later re-test clears an earlier failure of the same check.
      return fact.kind === 'content-equals' && fact.target === sandboxExitTarget(condition.kind)
    }
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
    // Content-first, matching the collector: when both sides carry a hash,
    // identical content keeps the run valid even if a no-op rewrite moved
    // the mtime; only a real content change invalidates the evidence.
    if (atRun.hash && current.hash) {
      if (atRun.hash !== current.hash) return false
    } else if (current.mtimeMs !== atRun.mtimeMs || current.size !== atRun.size) {
      return false
    }
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

/** True when a later run of the same check object exists (any outcome): the
 *  later run, not this one, speaks for the check's current state. */
function supersededByLaterRun(run: VerificationRun, allRuns: VerificationRun[]): boolean {
  const index = allRuns.indexOf(run)
  return allRuns.some((other, otherIndex) =>
    otherIndex > index
    && other.method === run.method
    && other.command === run.command
    && sameTargets(other.targets, run.targets)
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

/**
 * Validates a model completion claim against the evidence inventory and the
 * product's counter-evidence. Returns the rejection reasons (empty when the
 * completion is accepted).
 *
 * Task-matching evidence is either a currently valid, relevant, PASSING
 * verification run, or — when the product has NO runnable check to offer
 * (non-code work) — a product-observed workspace artifact the model produced.
 */
function validateCompletion(modelDecision: ModelDecisionShape, inventory: EvidenceInventoryEntry[], knownIssues: string[], runnableCheckCount: number): string[] {
  const rejection: string[] = []
  const byId = new Map(inventory.map((entry) => [entry.id, entry]))

  const unmet = modelDecision.coverage.filter((entry) => entry.status !== 'met')
  for (const entry of unmet) {
    rejection.push(`the model marked requirement "${truncate(entry.item, 160)}" as ${entry.status}; uncertain or unmet items cannot complete`)
  }
  if (modelDecision.coverage.length === 0) {
    rejection.push('the model\'s decision lists no requirement coverage; it cannot be accepted as a completion')
  }

  const problems: string[] = []
  let validRelevantPassed = 0
  let validArtifacts = 0
  for (const entry of modelDecision.coverage) {
    for (const id of entry.evidence) {
      const known = byId.get(id)
      if (!known) {
        problems.push(`cited evidence ${id} does not exist (cited for "${truncate(entry.item, 160)}")`)
        continue
      }
      if (!known.valid) {
        problems.push(`cited evidence ${id} (${known.description}) is stale`)
        continue
      }
      if (known.kind === 'verification') {
        if (known.relevant && known.outcome === 'passed') validRelevantPassed += 1
      } else {
        validArtifacts += 1
      }
    }
  }
  rejection.push(...problems)
  if (validRelevantPassed === 0 && !(validArtifacts > 0 && runnableCheckCount === 0)) {
    rejection.push(runnableCheckCount > 0
      ? 'no cited evidence is a currently valid, relevant, passing verification of the task (checks are available but none was cited as passing)'
      : 'no cited evidence is a currently valid, relevant, passing verification of the task')
  }
  if (knownIssues.length > 0) {
    rejection.push(...knownIssues)
  }
  return rejection
}

/** Materializes the sandbox wrapper scripts for script-kind checks under
 *  workspace-write. The product writes the script; the model runs it inside
 *  DSH's confined execution; the product reads the artifacts with its own
 *  executor. The .exit file carries the script's real exit code. */
function sandboxScriptsFor(requests: CheckRequest[], hints: WorkspaceHints, permission: PermissionPreset): SandboxScript[] {
  if (permission !== 'workspace-write') return []
  const scripts = new Map<string, SandboxScript>()
  for (const request of requests) {
    if (request.method.kind !== 'content-equals') continue
    const target: string = request.method.target
    const kind = (['tests', 'typecheck', 'build'] as const).find((candidate) => target === sandboxExitTarget(candidate))
    if (!kind) continue
    const script = resolveScriptCommand(kind, hints)
    if (!script || scripts.has(kind)) continue
    scripts.set(kind, {
      name: `${kind}.cmd`,
      command: `cmd /c ${VERIFY_DIR}\\${kind}.cmd`,
      content: [
        '@echo off',
        'cd /d "%~dp0.."',
        // `call` is required: npm/pnpm are batch files themselves, and
        // invoking one from a batch without `call` transfers control —
        // the exit-code line would never run.
        `call ${script} > "%~dp0${kind}.log" 2>&1`,
        `echo %ERRORLEVEL% > "%~dp0${kind}.exit"`,
        ''
      ].join('\r\n')
    })
  }
  return [...scripts.values()]
}

function buildNextPrompt(
  rootSpec: string,
  incomplete: string[],
  knownIssues: string[],
  inventory: EvidenceInventoryEntry[],
  modelDecision: ModelDecisionShape | undefined,
  sandboxScripts: SandboxScript[],
  rejectedCompletion: boolean
): string {
  const lines: string[] = []
  if (incomplete.length > 0) {
    lines.push('The task is not complete. The following required items still lack valid, passing verification evidence:')
    for (const line of incomplete) lines.push(`- ${truncate(line, 400)}`)
  }
  if (knownIssues.length > 0) {
    lines.push('Known workspace issues to resolve before the task can complete:')
    for (const issue of knownIssues) lines.push(`- ${truncate(issue, 400)}`)
  }
  if (rejectedCompletion) {
    lines.push('Your previous reply claimed the task was complete, but the product did NOT accept that claim (see the issues above).')
    lines.push('Reply with a NEW temporal-decision block. Set decision to "completed" only if every requirement is genuinely met, and cite the specific evidence ids from the inventory below that prove it: a currently valid, relevant, PASSING verification run — or a product-observed workspace artifact only when no check for the requirement exists. Never cite an id that is not in the inventory.')
  }
  if (inventory.length > 0) {
    lines.push('Evidence inventory (cite these ids in your decision block):')
    for (const entry of inventory) lines.push(`- ${entry.id}: ${entry.description}`)
  } else {
    lines.push('Evidence inventory: no verification has run yet.')
  }
  if (modelDecision?.nextAction?.trim()) {
    lines.push(`Your own stated next action: ${truncate(modelDecision.nextAction, 400)}`)
  }
  if (sandboxScripts.length > 0) {
    lines.push('Run these verification scripts exactly as written so the product can verify the results:')
    for (const script of sandboxScripts) lines.push(`- ${script.command}`)
  }
  lines.push(`Original spec: ${truncate(rootSpec, 2000)}`)
  lines.push('Continue the work. End your reply with the temporal-decision block as instructed. When you are genuinely blocked and need user input, set decision to "blocked" in that block.')
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
