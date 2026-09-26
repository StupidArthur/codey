import type { EvidenceBundle, FileStateMap, VerificationRequest, VerificationRun } from '../evidence/evidence'
import { extractRequirements, mentionPath, type RequiredItem } from './RequiredSpec'

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

/** A verification the loop should run next (executor fills cwd/turn). */
export type CheckRequest = Omit<VerificationRequest, 'cwd' | 'turn' | 'timeoutMs'>

export interface LoopDecision {
  decision: 'completed' | 'continue' | 'blocked' | 'failed'
  reason: string
  items: RequiredItem[]
  incomplete: string[]
  knownIssues: string[]
  nextPrompt: string
  nextChecks: CheckRequest[]
}

const TEST = /test|测试|单测|spec/i
const TYPECHECK = /typecheck|tsc\b|类型检查/i
const BUILD = /build|构建|编译/i
const WORKSPACE_FILE = /file|文件|create|创建|实现|add|新增/i

/**
 * The four-condition completion gate. Completion is never taken from the
 * model's own words: every required item must be satisfied by currently-valid,
 * relevant verification that actually ran and exited 0, with no known
 * counter-evidence (failed checks, failed DSH tools, permission denials,
 * artifacts modified or deleted after their check).
 */
export class LoopEvaluator {
  decide(input: DecideInput): LoopDecision {
    const { bundle, rootSpec, fileStates, changedTurnByFile, turn, hints } = input
    const items = extractRequirements(rootSpec)
    const knownIssues: string[] = []
    const validByRun = new Map<string, boolean>()
    const changedSet = new Set(bundle.changedFiles)
    const failedTools = unresolvedToolFailures(bundle.toolFacts)

    // 1. Validity: a run is void if any target changed or disappeared later.
    for (const run of bundle.verification) {
      validByRun.set(run.id, runValid(run, fileStates, changedTurnByFile))
    }

    // 2. Per-item status from the declared coverage of valid runs.
    for (const item of items) {
      const runs = bundle.verification.filter((run) => run.covers.includes(item.id))
      const validRuns = runs.filter((run) => validByRun.get(run.id))
      const passedRelevant = validRuns.some(
        (run) => run.outcome === 'passed' && relevant(run, changedSet)
      )
      if (passedRelevant) {
        item.status = 'satisfied'
        item.evidenceIds = validRuns.filter((run) => run.outcome === 'passed').map((run) => run.id)
        continue
      }
      const observed = validRuns.some((run) => run.outcome === 'observed')
      const failed = validRuns.some((run) => run.outcome === 'failed')
      if (failed) {
        item.status = 'pending'
        item.note = 'a check for this requirement failed'
        knownIssues.push(`${item.id} — a check failed (${failedLabel(validRuns)})`)
      } else if (observed) {
        item.status = 'unknown'
        item.note = 'verification ran but no exit code was produced'
      } else {
        item.status = 'pending'
        item.note = 'no valid verification evidence covers this requirement'
      }
    }

    // 3. Counter-evidence that can overturn a completion.
    for (const run of bundle.verification) {
      if (!validByRun.get(run.id)) {
        knownIssues.push(`${run.label} was invalidated (its targets changed or an artifact disappeared after the check)`)
      }
    }
    if (failedTools.length > 0) knownIssues.push(...failedTools)
    for (const run of bundle.verification) {
      if (validByRun.get(run.id) && run.outcome === 'failed') {
        knownIssues.push(`${run.label} failed (exit ${run.exitCode ?? 'n/a'})`)
      }
    }
    if (bundle.changedFiles.length === 0 && bundle.turnChangedFiles.length === 0 && bundle.verification.length === 0) {
      knownIssues.push('no files changed and no verification ran this turn')
    }

    // 4. The gate: all items satisfied, no counter-evidence.
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

    const nextChecks = this.suggestChecks(items, bundle, hints ?? EMPTY_HINTS)

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
   * Deterministic check selection for pending/unknown items. A requirement with
   * an explicit `Run:/Verify:` command gets that command executed; file-creation
   * requirements get an artifact-existence check; test/typecheck/build keywords
   * map to the repository scripts when present. Items with no objective check
   * method stay pending (honest: cannot fabricate coverage).
   */
  suggestChecks(items: RequiredItem[], bundle: EvidenceBundle, hints: WorkspaceHints): CheckRequest[] {
    const requests: CheckRequest[] = []
    const changed = bundle.changedFiles
    for (const item of items) {
      if (item.status === 'satisfied') continue
      if (item.acceptance) {
        requests.push({
          label: `verify ${item.id}`,
          command: 'cmd',
          args: ['/c', item.acceptance],
          scope: 'file',
          targets: changed.length > 0 ? changed : (mentionPath(item.original) ? [mentionPath(item.original)!] : []),
          covers: [item.id]
        })
        continue
      }
      if (TYPECHECK.test(item.original)) {
        if (hints.tsconfig || hints.hasTypecheckScript) {
          requests.push({
            label: 'typecheck',
            command: 'cmd',
            args: hints.hasTypecheckScript ? ['/c', 'npm run typecheck'] : ['/c', 'npx tsc --noEmit'],
            scope: 'workspace',
            targets: changed,
            covers: [item.id]
          })
        }
        continue
      }
      if (TEST.test(item.original) && hints.hasTestScript) {
        requests.push({ label: 'tests', command: 'cmd', args: ['/c', 'npm test'], scope: 'workspace', targets: changed, covers: [item.id] })
        continue
      }
      if (BUILD.test(item.original) && hints.hasBuildScript) {
        requests.push({ label: 'build', command: 'cmd', args: ['/c', 'npm run build'], scope: 'workspace', targets: changed, covers: [item.id] })
        continue
      }
      const path = mentionPath(item.original)
      if (path) {
        requests.push({
          label: `artifact ${item.id}`,
          command: 'cmd',
          args: ['/c', `if exist "${path}" (exit /b 0) else (exit /b 1)`],
          scope: 'file',
          targets: [path],
          covers: [item.id]
        })
      } else if (WORKSPACE_FILE.test(item.original) && changed.length > 0) {
        const target = changed[0]
        requests.push({
          label: `workspace-changed ${item.id}`,
          command: 'cmd',
          args: ['/c', `if exist "${target}" (exit /b 0) else (exit /b 1)`],
          scope: 'file',
          targets: [target],
          covers: [item.id]
        })
      }
    }
    return dedupeChecks(requests)
  }
}

function runValid(run: VerificationRun, fileStates: FileStateMap, changedTurnByFile: Map<string, number>): boolean {
  for (const target of run.targets) {
    const current = fileStates.get(target)
    const atRun = run.stamps.get(target)
    if (current === undefined || !current.exists) return false
    if (atRun === undefined || !atRun.exists) return false
    if (current.mtimeMs !== atRun.mtimeMs || current.size !== atRun.size) return false
    if ((changedTurnByFile.get(target) ?? 0) > run.turn) return false
  }
  return true
}

function relevant(run: VerificationRun, changedSet: Set<string>): boolean {
  if (run.scope === 'workspace') return changedSet.size > 0
  return run.targets.some((target) => changedSet.has(target))
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

function failedLabel(runs: VerificationRun[]): string {
  const failed = runs.find((run) => run.outcome === 'failed')
  return failed ? `${failed.label} (exit ${failed.exitCode ?? 'n/a'})` : 'unknown check'
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
    const key = `${request.label}\u0000${request.args.join(' ')}`
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
