import type { ExecutionOutcome, LoopTerminalSummary, PermissionPreset, RunnerEvent } from '../../shared/contracts'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { DshRuntime } from '../dsh/DshRuntime'
import { TURN_DEADLINE_MESSAGE } from '../dsh/DshRuntime'
import type { EvidenceCollector } from '../evidence/EvidenceCollector'
import type { EvidenceBundle, ToolCallFact, VerificationRequest, VerificationRun, VerificationExecutorFn } from '../evidence/evidence'
import { describeMethod } from '../evidence/VerificationExecutor'
import { LoopEvaluator, type CheckRequest, type LoopDecision, type SandboxScript, type WorkspaceHints } from './LoopEvaluator'
import { decisionInstruction, decisionReAskPrompt, extractDecision, type ModelDecisionShape } from './ModelDecision'

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
    const deadline = startedAt + this.budget.maxElapsedMs
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
    let prompt = decisionInstruction(input.rootSpec)
    let failure: string | undefined
    let lastDecision: LoopDecision | undefined
    let lastIncompleteCount = Number.MAX_SAFE_INTEGER
    let lastModelIncompleteCount = Number.MAX_SAFE_INTEGER
    const knownCheckSignatures = new Set<string>()

    for (;;) {
      // Budget before entering a turn: an exhausted loop must not start
      // another model round just because the previous turn ended cleanly.
      if (this.now() >= deadline) {
        return this.finish('budget_exhausted', 'Loop reached the 2 hour wall-clock budget before the next turn.', finalResponse, bundleOf(allRuns), continuations, lastDecision)
      }
      turn += 1
      failure = undefined
      let text = ''
      try {
        text = (await this.runtime.prompt(prompt, { timeoutMs: Math.max(deadline - this.now(), 1_000) })).text
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
        // A deadline termination is a budget exhaustion, not a runtime error:
        // it must be classified before the repeated-error rule can rename it.
        if (failure.includes(TURN_DEADLINE_MESSAGE)) {
          return this.finish(
            'budget_exhausted',
            'Loop reached the wall-clock budget during a model turn; the turn was cancelled through the public session/cancel and the collected evidence is preserved.',
            finalResponse, bundle, continuations, lastDecision
          )
        }
        const count = (errorCounts.get(failure) ?? 0) + 1
        errorCounts.set(failure, count)
        if (count >= this.budget.maxSameError) {
          return this.finish('failed', `Same error repeated ${count} times: ${truncate(failure)}`, finalResponse, bundle, continuations, lastDecision)
        }
      } else {
        finalResponse = text

        // The model's structured decision: parsed and schema-validated here,
        // with ONE strict re-ask when the block is missing or malformed.
        let modelDecision: ModelDecisionShape | undefined
        let decisionError: string | undefined
        if (!failure) {
          const parsed = extractDecision(text)
          if (parsed.ok) {
            modelDecision = parsed.decision
          } else if (this.now() < deadline) {
            const reAskDeadline = Math.max(deadline - this.now(), 1_000)
            try {
              const reAsk = await this.runtime.prompt(decisionReAskPrompt(parsed.error), { timeoutMs: reAskDeadline })
              const reParsed = extractDecision(reAsk.text)
              if (reParsed.ok) {
                modelDecision = reParsed.decision
                text = `${text}\n\n${reAsk.text}`
              } else {
                decisionError = reParsed.error
              }
            } catch (error) {
              decisionError = `re-ask for the decision block failed: ${error instanceof Error ? error.message : String(error)}`
            }
            const reAskFacts = (this.runtime.takeToolFacts?.() ?? []).map((fact: ToolCallFact) => ({ ...fact, turn }))
            bundle.toolFacts = [...bundle.toolFacts, ...reAskFacts]
          } else {
            decisionError = parsed.error
          }
        }

        const decide = (): LoopDecision => this.evaluator.decide({
          rootSpec: input.rootSpec, bundle, fileStates: snapshot.fileStates, changedTurnByFile, turn, hints,
          permission: input.permission, ...(modelDecision ? { modelDecision } : {}), ...(decisionError ? { decisionError } : {})
        })
        let decision = decide()
        lastDecision = decision
        if (decision.decision === 'completed') {
          // A nominally complete state that arrives after the deadline is not
          // accepted as completion.
          if (this.now() >= deadline) {
            return this.finish('budget_exhausted', 'Loop reached the 2 hour wall-clock budget; a nominally complete state arrived after the deadline and is not accepted as completed.', finalResponse, bundle, continuations, decision)
          }
          return this.finish('completed', decision.reason, finalResponse, bundle, continuations, decision)
        }
        if (decision.decision === 'blocked') {
          // The model's blocked call is final, but the product still runs its
          // own suggested checks first so the terminal Remaining names what
          // actually passed and what is missing (available evidence for every
          // terminal state).
          if (this.verify && decision.nextChecks.length > 0 && this.now() < deadline) {
            const checkDeadline = Math.max(deadline - this.now(), 1_000)
            const blockedRuns: VerificationRun[] = []
            for (const request of decision.nextChecks) {
              try {
                blockedRuns.push(await this.verify(this.withCwd(request, input, turn, checkDeadline)))
              } catch (error) {
                blockedRuns.push({
                  id: `verr-b${blockedRuns.length}-${turn}`,
                  turn, label: request.label, method: request.method.kind === 'shell' ? 'shell' : 'builtin',
                  command: describeMethod(request.method),
                  exitCode: null, signal: null, outputTail: String((error as Error)?.message ?? error).slice(0, 300),
                  scope: request.scope, targets: request.targets, facts: [], stamps: new Map(),
                  outcome: 'observed', at: new Date().toISOString()
                })
              }
            }
            if (blockedRuns.length > 0) {
              allRuns = allRuns.concat(blockedRuns)
              bundle.verification = allRuns
              // Re-decide with the same blocked model decision: the terminal
              // stays blocked, now with the checks' facts in the evidence.
              decision = decide()
              lastDecision = decision
            }
          }
          return this.finish('blocked', decision.reason, finalResponse, bundle, continuations, decision)
        }
        // Plain-text [BLOCKED] markers are candidate information only: they
        // are honored as a blocked terminal only when no structured decision
        // exists, and the saved decision still carries the remaining items.
        if (!modelDecision && BLOCKED_MARKER.test(text)) {
          return this.finish('blocked', 'The model reported that it needs user input to continue.', finalResponse, bundle, continuations, decision)
        }

        const newRuns: VerificationRun[] = []
        if (this.verify && decision.nextChecks.length > 0 && this.now() < deadline) {
          const checkDeadline = Math.max(deadline - this.now(), 1_000)
          for (const request of decision.nextChecks) {
            try {
              newRuns.push(await this.verify(this.withCwd(request, input, turn, checkDeadline)))
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
          decision = decide()
          lastDecision = decision
          if (decision.decision === 'completed') {
            if (this.now() >= deadline) {
              return this.finish('budget_exhausted', 'Loop reached the 2 hour wall-clock budget; a nominally complete state arrived after the deadline and is not accepted as completed.', finalResponse, bundle, continuations, decision)
            }
            return this.finish('completed', decision.reason, finalResponse, bundle, continuations, decision)
          }
        }

        // Meaningful progress only: content changes (hash-based, so identical
        // rewrites do not count), NEW passing checks (a repeated pass of the
        // same check object does not count), or a shrinking requirement list —
        // both the product's parsed items and the model's own coverage.
        const newDistinctPass = newRuns.some((run) =>
          run.outcome === 'passed'
          && !knownCheckSignatures.has(checkSignature(run))
        )
        for (const run of newRuns) {
          if (run.outcome === 'passed') knownCheckSignatures.add(checkSignature(run))
        }
        const progressed = bundle.turnChangedFiles.length > 0
          || newDistinctPass
          || decision.incomplete.length < lastIncompleteCount
          || (modelDecision ? modelDecision.incomplete.length < lastModelIncompleteCount : false)
        lastIncompleteCount = decision.incomplete.length
        if (modelDecision) lastModelIncompleteCount = modelDecision.incomplete.length
        noProgress = progressed ? 0 : noProgress + 1
        if (noProgress >= this.budget.maxNoProgress) {
          return this.finish('failed', `No progress after ${noProgress} consecutive continuations.`, finalResponse, bundle, continuations, decision)
        }

        // Sandbox verification scripts are product material: written by the
        // controller (workspace-write only), run by the model inside DSH's
        // confined execution, verified by the product's own executor.
        if (decision.sandboxScripts.length > 0) {
          await materializeScripts(input.workspacePath, decision.sandboxScripts)
        }
        prompt = decision.nextPrompt
      }

      if (this.now() >= deadline) {
        return this.finish('budget_exhausted', 'Loop reached the 2 hour wall-clock budget.', finalResponse, bundle, continuations, lastDecision)
      }
      if (continuations >= this.budget.maxContinuations) {
        return this.finish('budget_exhausted', `Loop reached the ${this.budget.maxContinuations} continuation budget.`, finalResponse, bundle, continuations, lastDecision)
      }
      continuations += 1
      if (failure) prompt = continueAfterFailure(input.rootSpec, bundle, failure)
    }
  }

  private withCwd(request: CheckRequest, input: LoopRunInput, turn: number, timeoutMs: number): VerificationRequest {
    return {
      ...request,
      cwd: input.workspacePath,
      turn,
      timeoutMs,
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

/** A minimal bundle for terminals that happen outside a collected turn
 *  (the pre-turn budget exit) so already-recorded runs are never dropped. */
function bundleOf(runs: VerificationRun[]): EvidenceBundle {
  return {
    changedFiles: [], turnChangedFiles: [], newFiles: [], deletedFiles: [], preexistingChanges: [],
    toolFacts: [], verification: runs, outcome: 'failed'
  }
}

async function workspaceHints(workspacePath: string): Promise<WorkspaceHints> {  const hints: WorkspaceHints = { packageJson: false, hasTypecheckScript: false, hasTestScript: false, hasBuildScript: false, tsconfig: false }
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
    `The previous attempt failed with: ${truncate(failure)}`,
    'End your reply with the temporal-decision block as instructed.'
  ]
  return lines.join('\n')
}

/** Identity of a check object: a re-run of the same check does not count as
 *  new progress even when it passes again. */
function checkSignature(run: VerificationRun): string {
  return `${run.method}|${run.command}|${[...run.targets].sort().join(',')}`
}

/** Write the loop's verification wrapper scripts into the workspace. The
 *  scripts make the model's in-sandbox runs verifiable: the real exit code
 *  and the full output land in files the product's own executor reads. */
async function materializeScripts(workspacePath: string, scripts: SandboxScript[]): Promise<void> {
  const dir = join(workspacePath, 'temporal-verify')
  await mkdir(dir, { recursive: true })
  for (const script of scripts) {
    await writeFile(join(dir, script.name), script.content, { encoding: 'utf8' })
  }
}

function truncate(text: string, max = 200): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}
