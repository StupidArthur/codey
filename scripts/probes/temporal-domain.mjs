/**
 * Phase B/C/D automated acceptance probe: product domain invariants, evidence
 * cross-check, Result composition, Loop state machine and cross-process leases.
 *
 * Run under Electron's Node (`node:sqlite` is only available in Electron's
 * bundled Node, not the system Node):
 *   $env:ELECTRON_RUN_AS_NODE=1
 *   .\node_modules\electron\dist\electron.exe scripts/probes/temporal-domain.mjs
 *
 * No model or credential is used; DSH is replaced by a deterministic fake so the
 * state machine itself is under test.
 */
import { createRequire } from 'node:module'
import { spawn } from 'node:child_process'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, '..', '..')
const require = createRequire(import.meta.url)
const esbuild = require(join(repoRoot, 'node_modules/.pnpm/esbuild@0.25.12/node_modules/esbuild/lib/main.js'))

async function bundle(entry, outfile, external = []) {
  await esbuild.build({
    entryPoints: [join(repoRoot, entry)], bundle: true, platform: 'node', format: 'cjs',
    outfile, external, logLevel: 'silent'
  })
  return require(outfile)
}

const storePath = join(here, '.cache-domain-store.cjs')
const enginePath = join(here, '.cache-domain-engine.cjs')
const { ProductStore } = await bundle('src/main/persistence/ProductStore.ts', storePath)
const { RoundEngine } = await bundle('src/main/rounds/RoundEngine.ts', enginePath)
const { EvidenceCollector } = await bundle('src/main/evidence/EvidenceCollector.ts', join(here, '.cache-domain-evidence.cjs'))
const { ResultBuilder } = await bundle('src/main/result/ResultBuilder.ts', join(here, '.cache-domain-result.cjs'))
const { LoopController, DEFAULT_LOOP_BUDGET } = await bundle('src/main/loop/LoopController.ts', join(here, '.cache-domain-loop.cjs'))

const checks = {}
const check = (name, value) => { checks[name] = Boolean(value) }

// ---------------------------------------------------------------------------
// Persistent store: migrations, drafts, rounds, projections.
// ---------------------------------------------------------------------------
const root = await mkdtemp(join(tmpdir(), 'temporal-domain-'))
const workspace = join(root, 'workspace')
const dbPath = join(root, 'product.sqlite')

const store = new ProductStore(dbPath)
const session = store.createSession(workspace, 'dsh-domain-1', 'Domain Session')
check('permission_defaults_workspace_write', store.getPermission(session.id) === 'workspace-write')
store.setPermission(session.id, 'danger-full-access')
check('permission_persists', store.getPermission(session.id) === 'danger-full-access')
store.setPermission(session.id, 'workspace-write')

store.saveDraft(session.id, 'draft one', 'plan')
store.saveDraft(session.id, 'draft two', 'plan')
const draft = store.getDraftWithRevision(session.id)
check('draft_revision_increments', draft.revision === 2 && draft.draft === 'draft two')
check('stale_revision_not_cleared', store.clearDraftIfRevision(session.id, 1) === false)
check('current_revision_cleared', store.clearDraftIfRevision(session.id, 2) === true && store.getDraft(session.id).draft === '')

const roundId = 'round-domain-1'
store.saveRound(session.id, { id: roundId, sequence: 1, mode: 'plan', status: 'active', title: 't', updatedAt: new Date().toISOString(), bodyMarkdown: '' })
store.markRoundExecutionStarted(session.id, roundId)
let refusedDoubleStart = false
try { store.markRoundExecutionStarted(session.id, roundId) } catch { refusedDoubleStart = true }
check('double_execution_refused', refusedDoubleStart)
store.markRoundExecutionFinished(session.id, roundId, 'active')
const finished = store.listRounds(session.id)[0]
check('execution_finished_keeps_round_active', finished.status === 'active')

store.appendPlanVersion(roundId, { id: 'pv1', submittedSpec: 's1', planMarkdown: 'plan one', createdAt: new Date().toISOString() })
store.appendPlanVersion(roundId, { id: 'pv2', submittedSpec: 's2', planMarkdown: 'plan two', createdAt: new Date().toISOString() })
check('plan_version_ordinals', store.listPlanVersions(roundId).map((v) => v.id).join(',') === 'pv1,pv2')

// A crashed execution (runtime_active = 1) is reconciled to interrupted, never completed.
const crashId = 'round-domain-crash'
store.saveRound(session.id, { id: crashId, sequence: 2, mode: 'vibe', status: 'active', title: 'crash', updatedAt: new Date().toISOString(), bodyMarkdown: '' })
store.markRoundExecutionStarted(session.id, crashId)
check('reconcile_marks_interrupted', store.reconcileInterruptedRounds(session.id) === 1)
const reconciled = store.listRounds(session.id).find((r) => r.id === crashId)
check('reconciled_status_interrupted', reconciled.status === 'interrupted')

store.saveEvidence(roundId, { id: 'ev1', kind: 'command', label: 'pnpm test', detail: 'ok', outcome: 'passed', provenance: 'tool', observedAt: new Date().toISOString() })
store.saveResult(roundId, { summary: 's', changes: [],
  verification: ['pnpm test — passed'], remaining: [], createdAt: new Date().toISOString() })
const details = store.listRoundDetails(session.id)
check('round_detail_projection', details[0].planVersions.length === 2 && details[0].evidence.length === 1 && details[0].result?.verification.length === 1)

// Same-process lease contention + release.
const leaseA = store.acquireSessionLease(session.id)
let sameProcessBlocked = false
try { store.acquireSessionLease(session.id) } catch { sameProcessBlocked = true }
check('same_process_lease_blocks', sameProcessBlocked)
leaseA.release()
const leaseB = store.acquireSessionLease(session.id)
check('lease_recoverable_after_release', leaseB.ownerToken !== leaseA.ownerToken)
leaseB.release()
store.close()

// ---------------------------------------------------------------------------
// Cross-process lease: a child Electron-Node process holds the lock.
// ---------------------------------------------------------------------------
const childScript = join(root, 'lease-child.cjs')
await writeFile(childScript, `
const { ProductStore } = require(${JSON.stringify(storePath)});
const store = new ProductStore(process.env.DOMAIN_DB);
const lease = store.acquireSessionLease(process.env.DOMAIN_SESSION);
process.stdout.write('HELD\\n');
process.stdin.on('data', () => { lease.release(); store.close(); process.exit(0); });
setInterval(() => {}, 1000);
`)
async function runLeaseChild(db, session, action) {
  const child = spawn(process.execPath, [childScript], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', DOMAIN_DB: db, DOMAIN_SESSION: session },
    stdio: ['pipe', 'pipe', 'pipe']
  })
  await new Promise((resolve, reject) => {
    child.stdout.once('data', resolve)
    child.once('error', reject)
    child.once('exit', (code) => reject(new Error(`lease child exited early: ${code}`)))
  })
  return child
}

const holder = await runLeaseChild(dbPath, session.id)
const parent = new ProductStore(dbPath)
let crossProcessBlocked = false
try { parent.acquireSessionLease(session.id) } catch { crossProcessBlocked = true }
check('cross_process_lease_blocks', crossProcessBlocked)
holder.stdin.write('release\n')
await new Promise((resolve) => holder.once('exit', resolve))
let crossProcessReleased = false
try { const l = parent.acquireSessionLease(session.id); l.release(); crossProcessReleased = true } catch { /* still held */ }
check('cross_process_lease_released_on_exit', crossProcessReleased)

const crashed = await runLeaseChild(dbPath, session.id)
crashed.kill()
await new Promise((resolve) => crashed.once('exit', resolve))
let stillBlockedAfterCrash = false
try { parent.acquireSessionLease(session.id) } catch { stillBlockedAfterCrash = true }
check('crash_keeps_lease_until_ttl', stillBlockedAfterCrash)
parent.close()

// ---------------------------------------------------------------------------
// Result builder cross-check: a model claim can never create verification.
// ---------------------------------------------------------------------------
const builder = new ResultBuilder()
const noEvidence = builder.build({
  finalResponse: 'Everything is done and all tests passed.',
  evidence: { changedFiles: ['a.ts'], newFiles: [], verification: [], outcome: 'completed' }
})
check('no_evidence_no_passed_verification', noEvidence.verification.length === 0)
const withEvidence = builder.build({
  finalResponse: 'Done.',
  evidence: { changedFiles: ['a.ts'], newFiles: ['a.ts'], verification: [{ label: 'pnpm test', detail: 'ok', outcome: 'passed', provenance: 'tool' }], outcome: 'completed' }
})
check('evidence_backs_verification', withEvidence.verification.length === 1 && withEvidence.changes[0].includes('created'))
const failed = builder.build({
  finalResponse: 'I could not finish.',
  evidence: { changedFiles: [], newFiles: [], verification: [], outcome: 'failed' },
  loopTerminal: { status: 'budget_exhausted', reason: '16 continuations' }
})
check('failed_result_has_reason', failed.remaining.some((line) => line.includes('16 continuations')))

// ---------------------------------------------------------------------------
// Loop state machine with a deterministic fake runtime and collector.
// ---------------------------------------------------------------------------
function fakeLoop({ prompts, bundles }) {
  let turn = 0
  const runtime = { prompt: async () => { const step = prompts[Math.min(turn, prompts.length - 1)]; turn += 1; if (step instanceof Error) throw step; return { text: step } } }
  const collector = {
    baseline: async () => ({ git: false, files: new Set(), startedAt: Date.now() }),
    collect: async () => bundles[Math.min(turn - 1, bundles.length - 1)]
  }
  return { controller: new LoopController(runtime, collector), turns: () => turn }
}

const noProgressInput = { rootSpec: 'do something', workspacePath: root, takeEvents: () => [] }
const noProgress = fakeLoop({ prompts: ['still working'], bundles: [{ changedFiles: [], newFiles: [], verification: [], outcome: 'completed' }] })
const noProgressResult = await noProgress.controller.run(noProgressInput)
check('loop_no_progress_fails', noProgressResult.terminal.status === 'failed' && noProgressResult.terminal.reason.includes('No progress'))
check('loop_no_progress_budget', noProgress.turns() === DEFAULT_LOOP_BUDGET.maxNoProgress)

const error = fakeLoop({
  prompts: [new Error('boom'), new Error('boom'), 'unused'],
  bundles: [{ changedFiles: [], newFiles: [], verification: [], outcome: 'failed' }]
})
const errorResult = await error.controller.run(noProgressInput)
check('loop_same_error_retry_limit', errorResult.terminal.status === 'failed' && error.turns() === DEFAULT_LOOP_BUDGET.maxSameError)

let progressCounter = 0
const runtimeProgress = { prompt: async () => ({ text: 'still missing required item' }) }
const collectorProgress = {
  baseline: async () => ({ git: false, files: new Set(), startedAt: Date.now() }),
  collect: async () => ({ changedFiles: [`file-${progressCounter++}.ts`], newFiles: [], verification: [], outcome: 'completed' })
}
const budgetController = new LoopController(runtimeProgress, collectorProgress)
const budgetResult = await budgetController.run(noProgressInput)
check('loop_budget_exhausted', budgetResult.terminal.status === 'budget_exhausted' && progressCounter === DEFAULT_LOOP_BUDGET.maxContinuations + 1)

const blocked = fakeLoop({ prompts: ['I am blocked and need your input to continue.'], bundles: [{ changedFiles: [], newFiles: [], verification: [], outcome: 'completed' }] })
const blockedResult = await blocked.controller.run(noProgressInput)
check('loop_blocked', blockedResult.terminal.status === 'blocked')

const complete = fakeLoop({ prompts: ['Done, tests pass.'], bundles: [{ changedFiles: ['x.ts'], newFiles: [], verification: [{ label: 'pnpm test', detail: 'ok', outcome: 'passed', provenance: 'tool' }], outcome: 'completed' }] })
const completeResult = await complete.controller.run(noProgressInput)
check('loop_completes_with_evidence', completeResult.terminal.status === 'completed' && complete.turns() === 1)

// ---------------------------------------------------------------------------
// RoundEngine: Plan reuse/versioning, Plan→Vibe finalize, Vibe accumulation,
// Loop new-round terminal, and evidence persistence through the real collector.
// ---------------------------------------------------------------------------
const engineRoot = await mkdtemp(join(tmpdir(), 'temporal-engine-ws-'))
const engineSession = storeLike()
function storeLike() {
  const s = new ProductStore(join(engineRoot, 'engine.sqlite'))
  return s
}
const projectSession = engineSession.createSession(engineRoot, undefined, 'Engine')
let fileCounter = 0
let verification = false
const runtime = {
  prompt: async () => {
    fileCounter += 1
    await writeFile(join(engineRoot, `artifact-${fileCounter}.txt`), 'x')
    return { text: `output ${fileCounter}` }
  }
}
const evidence = new EvidenceCollector()
const engine = new RoundEngine({
  store: engineSession,
  ensureRuntime: async () => runtime,
  evidence,
  resultBuilder: new ResultBuilder(),
  takeEvents: () => (verification ? [{ id: 'v', at: new Date().toISOString(), kind: 'verification', message: 'pnpm test' }] : []),
  onRoundChanged: () => {}
})

await engine.submit({ session: projectSession, mode: 'plan', spec: 'plan spec one' })
await engine.submit({ session: projectSession, mode: 'plan', spec: 'plan spec two' })
let rounds = engineSession.listRounds(projectSession.id)
check('plan_reuses_single_round', rounds.length === 1 && rounds[0].mode === 'plan')
check('plan_two_versions', engineSession.listPlanVersions(rounds[0].id).length === 2)

await engine.submit({ session: projectSession, mode: 'vibe', spec: 'vibe spec one' })
rounds = engineSession.listRounds(projectSession.id)
check('plan_to_vibe_finalizes_plan', rounds.length === 2 && rounds[0].status === 'completed' && rounds[1].mode === 'vibe' && rounds[1].status === 'active')
await engine.submit({ session: projectSession, mode: 'vibe', spec: 'vibe spec two' })
rounds = engineSession.listRounds(projectSession.id)
check('vibe_reuses_round', rounds.length === 2 && engineSession.listVibeEntries(rounds[1].id).length === 2)
await engine.endCurrent(projectSession)
rounds = engineSession.listRounds(projectSession.id)
const vibeResult = engineSession.getResult(rounds[1].id)
check('vibe_finalize_builds_result', rounds[1].status === 'completed' && Boolean(vibeResult))

verification = true
await engine.submit({ session: projectSession, mode: 'loop', spec: 'loop spec' })
rounds = engineSession.listRounds(projectSession.id)
const loopRound = rounds[2]
const loopResult = engineSession.getResult(loopRound.id)
check('loop_creates_new_terminal_round', rounds.length === 3 && loopRound.mode === 'loop' && loopRound.status === 'completed')
check('loop_result_terminal', loopResult?.loopTerminal?.status === 'completed')
check('evidence_persisted', engineSession.listEvidence(loopRound.id).some((record) => record.kind === 'workspace'))
engineSession.close()

const passed = Object.values(checks).every(Boolean)
console.log(JSON.stringify({ checks, passed }, null, 2))
if (!passed) process.exitCode = 1
