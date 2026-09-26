/**
 * TODO 6 §3 acceptance probe: natural-language loop with model-participated
 * assessment. Replaces the old loop-gate-impl probe: the regex parser is no
 * longer the completion authority — the model emits a structured decision and
 * the product validates its schema, the existence/validity of the evidence it
 * cites, counter-evidence, and budget.
 *
 * Layers tested:
 *  1. ModelDecision parsing/schema: valid, malformed, missing, wrong enums,
 *     last-block-wins, one strict re-ask through the real LoopController.
 *  2. Evaluator gate through the REAL evaluator, collector and verification
 *     executor: accepted completion, rejected citations, uncertain items,
 *     counter-evidence, blocked, no-decision, stale-evidence citations.
 *  3. Sandbox verification path (workspace-write): script conditions verify
 *     through product-written wrapper scripts run by the model inside DSH's
 *     sandbox, with the product reading the real exit artifact.
 *  4. Permission mapping: read-only has no script method; full access keeps
 *     direct shell.
 *
 * Run: node scripts/probes/loop-decision-gate.mjs
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createRequire } from 'node:module'
import { mkdtemp, rm, writeFile, mkdir, readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, '..', '..')
const require = createRequire(import.meta.url)
const esbuild = require(join(repoRoot, 'node_modules/.pnpm/esbuild@0.25.12/node_modules/esbuild/lib/main.js'))

async function bundle(entry, outfile) {
  await esbuild.build({ entryPoints: [join(repoRoot, entry)], bundle: true, platform: 'node', format: 'cjs', outfile, external: [], logLevel: 'silent' })
  return require(outfile)
}

const { LoopEvaluator, EMPTY_HINTS, VERIFY_DIR, sandboxExitTarget } = await bundle('src/main/loop/LoopEvaluator.ts', join(here, '.cache-gate-evaluator.cjs'))
const { LoopController, DEFAULT_LOOP_BUDGET } = await bundle('src/main/loop/LoopController.ts', join(here, '.cache-gate-controller.cjs'))
const { extractDecision, validateDecision, DECISION_FENCE } = await bundle('src/main/loop/ModelDecision.ts', join(here, '.cache-gate-decision.cjs'))
const { EvidenceCollector } = await bundle('src/main/evidence/EvidenceCollector.ts', join(here, '.cache-gate-evidence.cjs'))
const { VerificationExecutor } = await bundle('src/main/evidence/VerificationExecutor.ts', join(here, '.cache-gate-verify.cjs'))

const checks = {}
const check = (name, value) => { checks[name] = Boolean(value) }
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const executor = new VerificationExecutor()

// ===========================================================================
// 1. Decision parsing and schema validation
// ===========================================================================
{
  const good = { decision: 'incomplete', reason: 'work remains', coverage: [{ item: 'a file', status: 'unmet', evidence: [] }], incomplete: ['a file'], nextAction: 'write it' }
  const block = (object) => '```' + DECISION_FENCE + '\n' + JSON.stringify(object) + '\n```'
  const ok = extractDecision(`I did some work.\n\n${block(good)}\nMore prose is allowed after? No—block must be last-ish; parser takes the last block.`)
  check('parse_valid_block', ok.ok && ok.decision.decision === 'incomplete' && ok.decision.coverage[0].item === 'a file')

  const two = extractDecision(`${block(good)}\n${block({ decision: 'blocked', reason: 'stuck', coverage: [], incomplete: [] })}`)
  check('parse_last_block_wins', two.ok && two.decision.decision === 'blocked')

  check('parse_missing_block', !extractDecision('no block at all').ok)
  check('parse_broken_json', !extractDecision('```temporal-decision\n{not json}\n```').ok)
  check('parse_bad_enum', !validateDecision({ ...good, decision: 'done' }).ok)
  check('parse_bad_coverage_status', !validateDecision({ ...good, coverage: [{ item: 'x', status: 'fine', evidence: [] }] }).ok)
  check('parse_bad_evidence_type', !validateDecision({ ...good, coverage: [{ item: 'x', status: 'met', evidence: [3] }] }).ok)
  check('parse_empty_reason', !validateDecision({ ...good, reason: '' }).ok)
  check('parse_not_object', !validateDecision([1, 2]).ok)
}

// ===========================================================================
// Shared fixtures
// ===========================================================================
function emptySnapshot() {
  return { git: false, preexisting: new Set(), files: new Map(), dirty: new Map(), fileStates: new Map() }
}
function emptyBundle(extra = {}) {
  return { changedFiles: [], turnChangedFiles: [], newFiles: [], deletedFiles: [], preexistingChanges: [], toolFacts: [], verification: [], outcome: 'completed', ...extra }
}
function contentRun(id, target, matched, turn = 1) {
  return {
    id, turn, label: `content ${id}`, method: 'builtin', command: `builtin:content-equals ${target}`,
    exitCode: 0, signal: null, outputTail: matched ? 'content match' : 'content mismatch',
    scope: 'file', targets: [target],
    facts: [{ kind: 'content-equals', target, matched, expectedHash: 'a', ...(matched ? { actualHash: 'a' } : { actualHash: 'b' }) }],
    stamps: new Map([[target, { exists: true, mtimeMs: 1, size: 1, hash: 'a' }]]),
    outcome: matched ? 'passed' : 'failed', at: new Date().toISOString()
  }
}
const decisionBlock = (object) => '```' + DECISION_FENCE + '\n' + JSON.stringify(object) + '\n```'
const completedBlock = (citations) => decisionBlock({
  decision: 'completed', reason: 'everything is done',
  coverage: [{ item: 'the requirement', status: 'met', evidence: citations }],
  incomplete: [], nextAction: ''
})
const incompleteBlock = () => decisionBlock({
  decision: 'incomplete', reason: 'still working',
  coverage: [{ item: 'the requirement', status: 'unmet', evidence: [] }],
  incomplete: ['still to do'], nextAction: 'keep writing'
})

function decideInput(overrides = {}) {
  return {
    rootSpec: 'Create a file out.txt whose contents are exactly: done',
    bundle: emptyBundle(),
    fileStates: new Map([
      ['out.txt', { exists: true, mtimeMs: 1, size: 1, hash: 'a' }],
      ['other.txt', { exists: true, mtimeMs: 1, size: 1, hash: 'a' }]
    ]),
    changedTurnByFile: new Map(),
    turn: 1,
    hints: EMPTY_HINTS,
    permission: 'workspace-write',
    ...overrides
  }
}

// ===========================================================================
// 2. The evaluator gate
// ===========================================================================
{
  const evaluator = new LoopEvaluator()

  // No decision → continue with a known issue; never completed. (The
  // controller sets decisionError; direct evaluator callers pass it too.)
  const noDecision = evaluator.decide(decideInput({ decisionError: 'no temporal-decision fenced block found' }))
  check('no_decision_continues', noDecision.decision === 'continue')
  check('no_decision_known_issue', noDecision.knownIssues.some((issue) => issue.includes('no usable decision block')))

  // Model says completed but cites nothing, nothing verified → rejected.
  const bare = evaluator.decide(decideInput({ modelDecision: { decision: 'completed', reason: 'r', coverage: [{ item: 'x', status: 'met', evidence: [] }], incomplete: [] } }))
  check('completion_without_citations_rejected', bare.decision === 'continue' && bare.knownIssues.some((issue) => issue.includes('no cited evidence')))

  // Model cites a nonexistent id → rejected with a precise reason.
  const ghost = evaluator.decide(decideInput({ modelDecision: { decision: 'completed', reason: 'r', coverage: [{ item: 'x', status: 'met', evidence: ['e9'] }], incomplete: [] } }))
  check('ghost_citation_rejected', ghost.decision === 'continue' && ghost.knownIssues.some((issue) => issue.includes('e9') && issue.includes('does not exist')))

  // Uncertain coverage can never complete.
  const uncertain = evaluator.decide(decideInput({
    bundle: emptyBundle({ changedFiles: ['out.txt'], verification: [contentRun('r1', 'out.txt', true)] }),
    modelDecision: { decision: 'completed', reason: 'r', coverage: [{ item: 'x', status: 'uncertain', evidence: ['e1'] }], incomplete: [] }
  }))
  check('uncertain_never_completes', uncertain.decision === 'continue' && uncertain.knownIssues.some((issue) => issue.includes('uncertain')))

  // Counter-evidence: a failed run that was never cleared blocks completion.
  const counterEvidence = evaluator.decide(decideInput({
    bundle: emptyBundle({ changedFiles: ['out.txt'], verification: [contentRun('r1', 'out.txt', false)] }),
    modelDecision: { decision: 'completed', reason: 'r', coverage: [{ item: 'x', status: 'met', evidence: [] }], incomplete: [] }
  }))
  check('failed_run_blocks_completion', counterEvidence.decision === 'continue' && counterEvidence.knownIssues.some((issue) => issue.includes('failed')))

  // Stale evidence: a run whose target changed after the check is invalid.
  const stale = evaluator.decide(decideInput({
    bundle: emptyBundle({
      changedFiles: ['out.txt'],
      verification: [{ ...contentRun('r1', 'out.txt', true), stamps: new Map([['out.txt', { exists: true, mtimeMs: 999, size: 1, hash: 'zz' }]]) }]
    }),
    modelDecision: { decision: 'completed', reason: 'r', coverage: [{ item: 'x', status: 'met', evidence: ['e1'] }], incomplete: [] }
  }))
  check('stale_citation_rejected', stale.decision === 'continue' && stale.knownIssues.some((issue) => issue.includes('stale')))

  // The accepted path: model completed + cites e1, which is a valid, relevant,
  // passing verification of the changed target.
  const accepted = evaluator.decide(decideInput({
    bundle: emptyBundle({ changedFiles: ['out.txt'], verification: [contentRun('r1', 'out.txt', true)] }),
    modelDecision: { decision: 'completed', reason: 'the file is right', coverage: [{ item: 'out.txt content', status: 'met', evidence: ['e1'] }], incomplete: [] }
  }))
  check('valid_completion_accepted', accepted.decision === 'completed' && accepted.reason.includes('the file is right'))
  check('accepted_completion_records_valid_runs', accepted.validRunIds.includes('r1'))

  // Model blocked → terminal blocked with remaining items recorded.
  const blocked = evaluator.decide(decideInput({
    bundle: emptyBundle({ changedFiles: ['out.txt'] }),
    modelDecision: { decision: 'blocked', reason: 'need credentials', coverage: [{ item: 'x', status: 'unmet', evidence: [] }], incomplete: ['needs secret'] }
  }))
  check('model_blocked_terminal', blocked.decision === 'blocked' && blocked.reason.includes('credentials'))
  check('model_blocked_records_incomplete', blocked.incomplete.length > 0 && blocked.knownIssues.length === 0)

  // A stale run that was superseded by a later re-check of the same object is
  // history, not counter-evidence: the model re-running its own wrapper (or
  // the product re-checking) must not poison the loop permanently.
  {
    const stale = { ...contentRun('r-stale', 'out.txt', true), turn: 1, stamps: new Map([['out.txt', { exists: true, mtimeMs: 1, size: 1, hash: 'old' }]]) }
    const fresh = { ...contentRun('r-fresh', 'out.txt', true), turn: 2, stamps: new Map([['out.txt', { exists: true, mtimeMs: 2, size: 1, hash: 'new' }]]) }
    const states = new Map([['out.txt', { exists: true, mtimeMs: 2, size: 1, hash: 'new' }]])
    const superseded = evaluator.decide(decideInput({
      bundle: emptyBundle({ changedFiles: ['out.txt'], verification: [stale, fresh] }),
      fileStates: states,
      modelDecision: { decision: 'completed', reason: 'r', coverage: [{ item: 'x', status: 'met', evidence: ['e2'] }], incomplete: [] }
    }))
    check('superseded_stale_run_not_counter_evidence', superseded.decision === 'completed')
    // …but a stale run that is still the latest of its object remains
    // counter-evidence.
    const invalidated = evaluator.decide(decideInput({
      bundle: emptyBundle({ changedFiles: ['out.txt'], verification: [stale] }),
      fileStates: states,
      modelDecision: { decision: 'completed', reason: 'r', coverage: [{ item: 'x', status: 'met', evidence: ['e1'] }], incomplete: [] }
    }))
    check('latest_stale_run_still_counter_evidence', invalidated.decision === 'continue' && invalidated.knownIssues.some((issue) => issue.includes('invalidated')))
  }

  // Model incomplete → nextPrompt carries its own next action.
  const continuing = evaluator.decide(decideInput({
    modelDecision: { decision: 'incomplete', reason: 'r', coverage: [], incomplete: ['x'], nextAction: 'write the file now' }
  }))
  check('incomplete_continues_with_next_action', continuing.decision === 'continue' && continuing.nextPrompt.includes('write the file now'))

  // Non-code task with NO parseable check (purely subjective): a
  // product-observed workspace artifact cited by the model is valid evidence.
  const artifact = evaluator.decide(decideInput({
    rootSpec: 'Make the workspace documentation clear and useful for new contributors',
    bundle: emptyBundle({ changedFiles: ['NOTES.md'] }),
    fileStates: new Map([['NOTES.md', { exists: true, mtimeMs: 1, size: 300 }]]),
    modelDecision: { decision: 'completed', reason: 'document written', coverage: [{ item: 'NOTES.md', status: 'met', evidence: ['w1'] }], incomplete: [] }
  }))
  check('artifact_citation_completes_doc_task', artifact.decision === 'completed' && artifact.reason.includes('document written'))

  // When the spec names a file, the product has a runnable file check — an
  // artifact alone is not enough until the check itself passed (e1).
  const artifactWithChecks = evaluator.decide(decideInput({
    bundle: emptyBundle({ changedFiles: ['out.txt'] }),
    modelDecision: { decision: 'completed', reason: 'r', coverage: [{ item: 'x', status: 'met', evidence: ['w1'] }], incomplete: [] }
  }))
  check('artifact_citation_insufficient_when_checks_exist', artifactWithChecks.decision === 'continue' && artifactWithChecks.knownIssues.some((issue) => issue.includes('checks are available')))
  check('inventory_lists_workspace_artifacts', artifactWithChecks.nextPrompt.includes('w1: workspace artifact'))

  // A missing artifact (cited w1 for a file the snapshot no longer sees) is stale.
  const missingArtifact = evaluator.decide(decideInput({
    rootSpec: 'Write a document NOTES.md explaining the project',
    bundle: emptyBundle({ changedFiles: ['NOTES.md'] }),
    fileStates: new Map(),
    modelDecision: { decision: 'completed', reason: 'r', coverage: [{ item: 'x', status: 'met', evidence: ['w1'] }], incomplete: [] }
  }))
  check('missing_artifact_citation_rejected', missingArtifact.decision === 'continue' && missingArtifact.knownIssues.some((issue) => issue.includes('stale')))
}

// ===========================================================================
// 3. Full gate through the real LoopController + collector + executor
// ===========================================================================
{
  const gateRoot = await mkdtemp(join(tmpdir(), 'temporal-gate2-'))
  let turns = 0
  const gateRuntime = {
    prompt: async () => {
      turns += 1
      await mkdir(join(gateRoot, 'src'), { recursive: true })
      await writeFile(join(gateRoot, 'src', 'answer.txt'), 'verify\n')
      return { text: `I created the file.\n\n${completedBlock(['e1'])}` }
    }
  }
  const controller = new LoopController(gateRuntime, new EvidenceCollector(), DEFAULT_LOOP_BUDGET, Date.now, executor.run)
  const result = await controller.run({
    rootSpec: 'Create a file src/answer.txt whose contents are exactly: verify',
    workspacePath: gateRoot, permission: 'workspace-write', takeEvents: () => []
  })
  check('gate_completes_with_model_decision_and_builtin_fact', result.terminal.status === 'completed')
  check('gate_completion_backed_by_content_fact', result.evidence.verification.some(
    (run) => run.outcome === 'passed' && run.method === 'builtin' && run.facts.some((fact) => fact.kind === 'content-equals' && fact.matched)
  ))
  check('gate_decision_saved', result.decision?.decision === 'completed')
  await rm(gateRoot, { recursive: true, force: true }).catch(() => {})
}

// One strict re-ask when the reply lacks the decision block.
{
  const reRoot = await mkdtemp(join(tmpdir(), 'temporal-gate-reask-'))
  const prompts = []
  const reRuntime = {
    prompt: async (promptText) => {
      prompts.push(String(promptText))
      await writeFile(join(reRoot, 'out.txt'), 'done\n')
      const isReAsk = prompts.length === 2
      return { text: isReAsk ? completedBlock(['e1']) : 'I made the file but forgot the block.' }
    }
  }
  const controller = new LoopController(reRuntime, new EvidenceCollector(), DEFAULT_LOOP_BUDGET, Date.now, executor.run)
  const result = await controller.run({ rootSpec: 'Create a file out.txt whose contents are exactly: done', workspacePath: reRoot, permission: 'workspace-write', takeEvents: () => [] })
  check('reask_prompt_sent_once', prompts.length === 2 && prompts[1].includes('Reply NOW'))
  check('reask_recovers_completion', result.terminal.status === 'completed')
  await rm(reRoot, { recursive: true, force: true }).catch(() => {})
}

// ===========================================================================
// 4. Sandbox verification path (workspace-write) and permission mapping
// ===========================================================================
{
  const ws = await mkdtemp(join(tmpdir(), 'temporal-sandbox-'))
  await writeFile(join(ws, 'package.json'), JSON.stringify({ scripts: { test: 'node successful-tests.js' } }))
  const hints = { packageJson: true, hasTypecheckScript: false, hasTestScript: true, hasBuildScript: false, tsconfig: false }
  const evaluator = new LoopEvaluator()
  const decision = evaluator.decide(decideInput({
    rootSpec: 'Add a feature and make sure tests pass',
    hints,
    permission: 'workspace-write',
    modelDecision: { decision: 'incomplete', reason: 'tests not run yet', coverage: [{ item: 'tests pass', status: 'uncertain', evidence: [] }], incomplete: ['tests pass'], nextAction: 'run the test script' }
  }))
  const sandboxCheck = decision.nextChecks.find((request) => request.method.kind === 'content-equals' && request.method.target === sandboxExitTarget('tests'))
  check('sandbox_exit_artifact_check_suggested', Boolean(sandboxCheck))
  check('sandbox_script_materialized', decision.sandboxScripts.length === 1 && decision.sandboxScripts[0].name === 'tests.cmd')
  check('sandbox_script_runs_the_real_test_command', decision.sandboxScripts[0].content.includes('call npm test'))
  check('sandbox_command_in_next_prompt', decision.nextPrompt.includes('cmd /c temporal-verify'))

  // The executor refuses a direct shell test run under workspace-write…
  const direct = await executor.run({
    label: 'tests', method: { kind: 'shell', command: 'cmd', args: ['/c', 'npm test'] },
    cwd: ws, scope: 'workspace', targets: [], turn: 1,
    permission: { preset: 'workspace-write', workspacePath: ws }
  })
  check('direct_shell_still_denied_under_workspace_write', direct.outcome === 'denied')

  // …but the sandbox artifact path verifies: the controller materializes the
  // wrapper scripts (as LoopController does), the model "runs" the wrapper
  // (here the probe does exactly what the wrapper does), and the product's
  // own builtin check reads the real exit artifact.
  await mkdir(join(ws, VERIFY_DIR), { recursive: true })
  for (const script of decision.sandboxScripts) {
    await writeFile(join(ws, VERIFY_DIR, script.name), script.content)
  }
  await writeFile(join(ws, 'successful-tests.js'), 'console.log("all tests passed")\n')
  const run = promisify(execFile)
  await run('cmd', ['/c', 'temporal-verify\\tests.cmd'], { cwd: ws, windowsHide: true })
  const exitArtifact = await readFile(join(ws, VERIFY_DIR, 'tests.exit'), 'utf8')
  check('wrapper_wrote_real_exit_code', exitArtifact.trim() === '0')
  const verification = await executor.run({
    label: 'tests', method: { kind: 'content-equals', target: sandboxExitTarget('tests'), expected: '0' },
    cwd: ws, scope: 'file', targets: [sandboxExitTarget('tests'), `${VERIFY_DIR}/tests.log`], turn: 2,
    permission: { preset: 'workspace-write', workspacePath: ws }
  })
  check('sandbox_verification_passes', verification.outcome === 'passed' && verification.facts[0]?.matched)

  // Failing tests produce a real non-zero artifact, which fails the check.
  await writeFile(join(ws, 'successful-tests.js'), 'process.exit(3)\n')
  await run('cmd', ['/c', 'temporal-verify\\tests.cmd'], { cwd: ws, windowsHide: true })
  const failedVerification = await executor.run({
    label: 'tests', method: { kind: 'content-equals', target: sandboxExitTarget('tests'), expected: '0' },
    cwd: ws, scope: 'file', targets: [sandboxExitTarget('tests'), `${VERIFY_DIR}/tests.log`], turn: 3,
    permission: { preset: 'workspace-write', workspacePath: ws }
  })
  check('sandbox_verification_fails_on_real_failure', failedVerification.outcome === 'failed')

  // The evaluator then reports the item as covered only by the valid artifact.
  const afterFailure = evaluator.decide(decideInput({
    rootSpec: 'make tests pass', hints, permission: 'workspace-write',
    bundle: emptyBundle({ changedFiles: [`${VERIFY_DIR}/tests.exit`], verification: [failedVerification] }),
    fileStates: new Map(failedVerification.stamps)
  }))
  check('failed_artifact_is_counter_evidence', afterFailure.knownIssues.some((issue) => issue.includes('tests failed')))
  await rm(ws, { recursive: true, force: true }).catch(() => {})
}

{
  // Read-only: script conditions have no method (stay unknown) and no
  // sandbox scripts are materialized.
  const evaluator = new LoopEvaluator()
  const readOnly = evaluator.decide(decideInput({
    rootSpec: 'make tests pass',
    hints: { packageJson: true, hasTypecheckScript: false, hasTestScript: true, hasBuildScript: false, tsconfig: false },
    permission: 'read-only',
    modelDecision: { decision: 'incomplete', reason: 'r', coverage: [], incomplete: ['tests pass'], nextAction: '' }
  }))
  check('readonly_has_no_script_method', readOnly.nextChecks.every((request) => request.method.kind !== 'shell') && readOnly.sandboxScripts.length === 0)

  // Full access keeps the direct shell check.
  const fullAccess = evaluator.decide(decideInput({
    rootSpec: 'make tests pass',
    hints: { packageJson: true, hasTypecheckScript: false, hasTestScript: true, hasBuildScript: false, tsconfig: false },
    permission: 'danger-full-access',
    modelDecision: { decision: 'incomplete', reason: 'r', coverage: [], incomplete: ['tests pass'], nextAction: '' }
  }))
  check('full_access_keeps_direct_shell', fullAccess.nextChecks.some((request) => request.method.kind === 'shell' && request.method.command === 'cmd') && fullAccess.sandboxScripts.length === 0)
}

// ===========================================================================
// 5. Meaningful no-progress: identical rewrites and repeated passes do not
//    reset the counter; shrinking incomplete lists do.
// ===========================================================================
{
  const controller = new LoopController(
    { prompt: async () => ({ text: incompleteBlock() }) },
    { baseline: async () => emptySnapshot(), collect: async () => ({ bundle: emptyBundle(), snapshot: emptySnapshot() }) },
    { ...DEFAULT_LOOP_BUDGET, maxNoProgress: 2 },
    Date.now
  )
  const result = await controller.run({ rootSpec: 'do something', workspacePath: 'unused', permission: 'workspace-write', takeEvents: () => [] })
  check('no_progress_fails_without_meaningful_change', result.terminal.status === 'failed' && result.terminal.reason.includes('No progress'))
}

{
  let passCount = 0
  const controller = new LoopController(
    { prompt: async () => ({ text: incompleteBlock() }) },
    {
      baseline: async () => emptySnapshot(),
      collect: async () => {
        passCount += 1
        return { bundle: emptyBundle({ verification: [] }), snapshot: emptySnapshot() }
      }
    },
    { ...DEFAULT_LOOP_BUDGET, maxNoProgress: 2, maxContinuations: 5 },
    Date.now,
    async () => {
      // The same check object passes again and again (same command/targets).
      return { ...contentRun('same-run', 'out.txt', true), id: 'same-run' }
    }
  )
  const result = await controller.run({ rootSpec: 'Create a file out.txt whose contents are exactly: done', workspacePath: 'unused', permission: 'workspace-write', takeEvents: () => [] })
  check('repeated_same_check_not_progress', result.terminal.status === 'failed' && result.terminal.reason.includes('No progress'))
}

{
  // Shrinking incomplete list counts as progress (coverage progression): the
  // loop keeps making progress until the continuation budget ends it — it
  // must never die of "no progress" while the model's coverage grows.
  let shrinking = 3
  const controller = new LoopController(
    { prompt: async () => ({ text: decisionBlock({ decision: 'incomplete', reason: 'r', coverage: [], incomplete: new Array(shrinking).fill('item'), nextAction: '' }) }) },
    {
      baseline: async () => emptySnapshot(),
      collect: async () => {
        shrinking = Math.max(0, shrinking - 1)
        return { bundle: emptyBundle(), snapshot: emptySnapshot() }
      }
    },
    { ...DEFAULT_LOOP_BUDGET, maxNoProgress: 5, maxContinuations: 5 },
    Date.now
  )
  const result = await controller.run({ rootSpec: 'multi-part task', workspacePath: 'unused', permission: 'workspace-write', takeEvents: () => [] })
  check('coverage_progression_counts_as_progress', result.terminal.status === 'budget_exhausted' && result.terminal.reason.includes('continuation budget') && !result.terminal.reason.includes('No progress'))
}

const failed = Object.entries(checks).filter(([, ok]) => !ok)
console.log(JSON.stringify({ checks, passed: failed.length === 0, failed: failed.map(([name]) => name) }, null, 2))
process.exit(failed.length === 0 ? 0 : 1)
