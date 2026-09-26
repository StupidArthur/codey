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
import { createHash } from 'node:crypto'
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
const { inputFingerprint } = await bundle('src/main/evidence/evidence.ts', join(here, '.cache-gate-evidence-lib.cjs'))

const checks = {}
const check = (name, value) => { checks[name] = Boolean(value) }
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const executor = new VerificationExecutor()
const sha1 = (text) => createHash('sha1').update(text, 'utf8').digest('hex')

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
  // The exact run-command lines are appended by the controller (which resolves
  // the per-request nonce names), not baked into the evaluator's prompt.
  check('sandbox_run_lines_owned_by_controller', !decision.nextPrompt.includes('Run these verification scripts'))

  // The executor refuses a direct shell test run under workspace-write…
  const direct = await executor.run({
    label: 'tests', method: { kind: 'shell', command: 'cmd', args: ['/c', 'npm test'] },
    cwd: ws, scope: 'workspace', targets: [], turn: 1,
    permission: { preset: 'workspace-write', workspacePath: ws }
  })
  check('direct_shell_still_denied_under_workspace_write', direct.outcome === 'denied')

  // …but the sandbox artifact path verifies: the controller materializes the
  // wrapper scripts under a REQUEST-SPECIFIC nonce name (as LoopController
  // does), the model "runs" the wrapper (here the probe does exactly what the
  // wrapper does), and the product's own builtin check reads the nonce exit
  // artifact. A leftover fixed-name artifact from a previous Round can never
  // satisfy the request.
  const rid = 'a1b2c3d4'
  // The input fingerprint the request is bound to: computed from the same
  // project-input file states the evaluator will compare at decide time, so
  // the probe exercises real fingerprint semantics, not a placeholder.
  const inputState = new Map([
    ['feature.js', { exists: true, mtimeMs: 1, size: 1, hash: 'abc' }],
    ['package.json', { exists: true, mtimeMs: 1, size: 1, hash: 'def' }]
  ])
  const fingerprint = inputFingerprint(inputState)
  await mkdir(join(ws, VERIFY_DIR), { recursive: true })
  await writeFile(join(ws, 'successful-tests.js'), 'console.log("all tests passed")\n')
  const run = promisify(execFile)
  // Previous Round leftover: fixed-name exit file claiming success. It must
  // NOT satisfy the current request's nonce check.
  await writeFile(join(ws, VERIFY_DIR, 'tests.exit'), '0\n')
  // Mirror what the controller materializes for the request: a nonce-named
  // wrapper whose log/exit artifacts carry the same nonce.
  const wrapper = decision.sandboxScripts[0]
  const nonceWrapper = {
    name: `tests-${rid}.cmd`,
    command: `cmd /c ${VERIFY_DIR}\\tests-${rid}.cmd`,
    content: wrapper.content
      .replace('%~dp0tests.log', `%~dp0tests-${rid}.log`)
      .replace('%~dp0tests.exit', `%~dp0tests-${rid}.exit`)
      .replace(/call npm test/, 'call node successful-tests.js')
  }
  await writeFile(join(ws, VERIFY_DIR, nonceWrapper.name), nonceWrapper.content)
  await run('cmd', ['/c', `temporal-verify\\tests-${rid}.cmd`], { cwd: ws, windowsHide: true })
  const exitArtifact = await readFile(join(ws, VERIFY_DIR, `tests-${rid}.exit`), 'utf8')
  check('wrapper_wrote_real_exit_code', exitArtifact.trim() === '0')
  const nonceTarget = `${VERIFY_DIR}/tests-${rid}.exit`
  const verification = await executor.run({
    label: 'tests', method: { kind: 'content-equals', target: nonceTarget, expected: '0' },
    cwd: ws, scope: 'workspace', targets: [nonceTarget, `${VERIFY_DIR}/tests-${rid}.log`], turn: 2,
    requestId: rid, inputFingerprint: fingerprint, checkObject: 'sandbox:tests',
    permission: { preset: 'workspace-write', workspacePath: ws }
  })
  check('sandbox_verification_passes', verification.outcome === 'passed' && verification.facts[0]?.matched)
  check('sandbox_run_keeps_request_identity', verification.requestId === rid && verification.checkObject === 'sandbox:tests' && verification.inputFingerprint === fingerprint)

  // A different request's artifact path does not exist, so a check bound to
  // that request cannot be satisfied by this request's leftover file.
  const otherRid = 'zzzz9999'
  const otherTarget = `${VERIFY_DIR}/tests-${otherRid}.exit`
  const leftoverCheck = await executor.run({
    label: 'tests', method: { kind: 'content-equals', target: otherTarget, expected: '0' },
    cwd: ws, scope: 'workspace', targets: [otherTarget], turn: 2,
    requestId: otherRid, inputFingerprint: fingerprint, checkObject: 'sandbox:tests',
    permission: { preset: 'workspace-write', workspacePath: ws }
  })
  check('old_exit_artifact_does_not_satisfy_new_request', leftoverCheck.outcome === 'failed')

  // Failing tests produce a real non-zero artifact, which fails the check.
  await writeFile(join(ws, 'successful-tests.js'), 'process.exit(3)\n')
  await run('cmd', ['/c', `temporal-verify\\tests-${rid}.cmd`], { cwd: ws, windowsHide: true })
  const failedVerification = await executor.run({
    label: 'tests', method: { kind: 'content-equals', target: nonceTarget, expected: '0' },
    cwd: ws, scope: 'workspace', targets: [nonceTarget, `${VERIFY_DIR}/tests-${rid}.log`], turn: 3,
    requestId: rid, inputFingerprint: fingerprint, checkObject: 'sandbox:tests',
    permission: { preset: 'workspace-write', workspacePath: ws }
  })
  check('sandbox_verification_fails_on_real_failure', failedVerification.outcome === 'failed')

  // The evaluator then reports the item as covered only by the valid artifact.
  const afterFailure = evaluator.decide(decideInput({
    rootSpec: 'make tests pass', hints, permission: 'workspace-write',
    bundle: emptyBundle({ changedFiles: ['feature.js'], verification: [failedVerification] }),
    // Project inputs (same hashes as the fingerprint) plus the nonce artifact
    // stamps (excluded from the fingerprint): the run stays current-bound.
    fileStates: new Map([...inputState, ...failedVerification.stamps]),
    sandboxRequests: new Map([['tests', { rid, fingerprint }]])
  }))
  check('failed_artifact_is_counter_evidence', afterFailure.knownIssues.some((issue) => issue.includes('tests failed')))
  await rm(ws, { recursive: true, force: true }).catch(() => {})
}

{
  // 4b. Controller-owned sandbox request identity, end to end through the real
  // collector + executor + controller: the prompt passed to the model carries
  // THIS request's nonce run command, the wrapper materialized is nonce-named,
  // and a leftover fixed-name `.exit` from a previous Round cannot satisfy the
  // request. The "model" here is a deterministic fake that writes the feature
  // file and runs whatever nonce wrapper the prompt commands.
  const ws = await mkdtemp(join(tmpdir(), 'temporal-sandbox-ctrl-'))
  await writeFile(join(ws, 'package.json'), JSON.stringify({ name: 'probe', scripts: { test: 'node feature-check.js' } }))
  await writeFile(join(ws, 'feature-check.js'), 'const fs = require("fs"); if (!fs.existsSync("feature.js")) { console.error("missing feature.js"); process.exit(1) } console.log("feature ok")\n')
  // Previous Round leftover that claims tests pass — must never satisfy the
  // fresh request.
  await mkdir(join(ws, VERIFY_DIR), { recursive: true })
  await writeFile(join(ws, VERIFY_DIR, 'tests.exit'), '0\n')
  const run = promisify(execFile)
  const prompts = []
  const runtime = {
    prompt: async (promptText) => {
      prompts.push(promptText)
      if (!prompts.some((p) => p.includes('Evidence inventory'))) {
        // First turn: do the work, then report incomplete.
        await writeFile(join(ws, 'feature.js'), 'module.exports = 1\n')
        return { text: incompleteBlock() }
      }
      // Later turns: run the exact wrapper the controller told us to run.
      const match = promptText.match(/cmd \/c (temporal-verify\\[\w-]+\.cmd)/)
      if (match) await run('cmd', ['/c', match[1]], { cwd: ws, windowsHide: true })
      const ids = [...promptText.matchAll(/^- (e\d+):/gm)].map((m) => m[1])
      const evidence = ids.length > 0 ? [ids[ids.length - 1]] : []
      return { text: completedBlock(evidence) }
    },
    takeToolFacts: () => []
  }
  const collector = new EvidenceCollector()
  const controller = new LoopController(runtime, collector, { ...DEFAULT_LOOP_BUDGET, maxContinuations: 8, maxNoProgress: 5 }, Date.now, async (request) => executor.run(request))
  const result = await controller.run({
    rootSpec: 'Add a feature and make sure the tests pass',
    workspacePath: ws, permission: 'workspace-write', takeEvents: () => []
  })
  const runPrompt = prompts.find((p) => p.includes('Run these verification scripts'))
  check('sandbox_controller_appends_nonce_run_command', Boolean(runPrompt) && /cmd \/c temporal-verify\\tests-[0-9a-f]+\.cmd/.test(runPrompt))
  check('sandbox_controller_flow_completes', result.terminal.status === 'completed')
  const passedSandbox = result.evidence.verification.find((run) => run.outcome === 'passed' && run.checkObject === 'sandbox:tests')
  check('sandbox_pass_has_request_identity', Boolean(passedSandbox?.requestId && passedSandbox?.inputFingerprint && passedSandbox?.checkObject === 'sandbox:tests'))
  // The leftover `tests.exit` did not satisfy the request: the first check on
  // the nonce artifact path failed before the model ran the wrapper.
  check('leftover_exit_did_not_satisfy_request', result.evidence.verification.some((run) => run.outcome === 'failed' && run.checkObject === 'sandbox:tests'))
  // The Result states the honest sandbox source, never a directly-observed exit.
  const { ResultBuilder } = await bundle('src/main/result/ResultBuilder.ts', join(here, '.cache-gate-result.cjs'))
  const doc = new ResultBuilder().build({
    finalResponse: result.finalResponse,
    evidence: result.evidence,
    outcome: result.terminal.status === 'completed' ? 'completed' : 'failed',
    loopTerminal: result.terminal,
    decision: result.decision,
    round: { mode: 'loop', turns: [{ spec: 'Add a feature and make sure the tests pass', outcome: 'completed', output: result.finalResponse }] }
  })
  check('result_states_sandbox_source', doc.verification.some((line) => line.includes('tests') && line.includes('DSH 沙盒检查报告；产品核实结果产物及输入快照')))
  await rm(ws, { recursive: true, force: true }).catch(() => {})
}

{
  // 4c. TODO 7 §2 A acceptance: sandbox check evidence is bound to the
  // workspace INPUTS it was requested against. The check carries a request
  // nonce and the input fingerprint of the snapshot it was requested on; a run
  // is only CURRENT evidence while both still match. Source/test/project
  // config changes, additions and deletions invalidate it; check-artifact-only
  // changes never do; a re-check supersedes the old pass.
  const evaluator = new LoopEvaluator()
  const hintT = { packageJson: true, hasTypecheckScript: false, hasTestScript: true, hasBuildScript: false, tsconfig: false }
  const fpOf = (states) => inputFingerprint(states)
  const sandboxRun = (id, rid, fingerprint, turn = 3) => {
    const exit = `${VERIFY_DIR}/tests-${rid}.exit`
    const log = `${VERIFY_DIR}/tests-${rid}.log`
    return {
      id, turn, label: 'tests', method: 'builtin', command: `builtin:content-equals ${exit}`,
      exitCode: 0, signal: null, outputTail: 'content match', scope: 'workspace', targets: [exit, log],
      facts: [{ kind: 'content-equals', target: exit, expectedHash: sha1('0'), actualHash: sha1('0'), matched: true }],
      stamps: new Map([
        [exit, { exists: true, mtimeMs: 3, size: 1, hash: sha1('0') }],
        [log, { exists: true, mtimeMs: 3, size: 1, hash: sha1('0') }]
      ]),
      outcome: 'passed', requestId: rid, inputFingerprint: fingerprint, checkObject: 'sandbox:tests', at: ''
    }
  }
  const inputA = new Map([
    ['feature.js', { exists: true, mtimeMs: 1, size: 1, hash: 'aaa' }],
    ['package.json', { exists: true, mtimeMs: 1, size: 1, hash: 'ppp' }]
  ])
  const fpA = fpOf(inputA)
  const inputB = new Map([
    ['feature.js', { exists: true, mtimeMs: 1, size: 1, hash: 'bbb' }],
    ['package.json', { exists: true, mtimeMs: 1, size: 1, hash: 'ppp' }]
  ])
  const fpB = fpOf(inputB)
  const artifactStates = new Map([
    [`${VERIFY_DIR}/tests-r1.exit`, { exists: true, mtimeMs: 3, size: 1, hash: sha1('0') }],
    [`${VERIFY_DIR}/tests-r1.log`, { exists: true, mtimeMs: 3, size: 1, hash: sha1('0') }]
  ])
  const baseDecide = (overrides) => evaluator.decide(decideInput({
    rootSpec: 'make tests pass', hints: hintT, permission: 'workspace-write',
    bundle: emptyBundle({ changedFiles: ['feature.js'], verification: [sandboxRun('r1', 'r1', fpA)] }),
    fileStates: new Map([...inputA, ...artifactStates]),
    sandboxRequests: new Map([['tests', { rid: 'r1', fingerprint: fpA }]]),
    ...overrides
  }))

  // (a) Real check passed, inputs unchanged → the pass is current and valid.
  const same = baseDecide({})
  check('a_unchanged_inputs_keeps_sandbox_pass_current', same.validRunIds.includes('r1'))

  // (b) Source content changed after the check → the old pass is invalid and
  // cannot support completion.
  const changedSource = baseDecide({ fileStates: new Map([...inputB, ...artifactStates]) })
  check('a_source_change_invalidates_sandbox_pass', !changedSource.validRunIds.includes('r1') && changedSource.knownIssues.some((issue) => issue.includes('invalidated')))

  // (c) A project input was added or deleted → fingerprint changes → invalid.
  const removedInput = new Map([...inputA])
  removedInput.delete('feature.js')
  const removed = baseDecide({ fileStates: new Map([...removedInput, ...artifactStates]) })
  check('a_input_removal_invalidates_sandbox_pass', !removed.validRunIds.includes('r1'))
  const addedInput = new Map([...inputA, ['extra.ts', { exists: true, mtimeMs: 1, size: 1, hash: 'zzz' }]])
  const added = baseDecide({ fileStates: new Map([...addedInput, ...artifactStates]) })
  check('a_input_addition_invalidates_sandbox_pass', !added.validRunIds.includes('r1'))

  // (d) Test script / project config changed (package.json) → invalid.
  const configChanged = new Map([
    ['feature.js', { exists: true, mtimeMs: 1, size: 1, hash: 'aaa' }],
    ['package.json', { exists: true, mtimeMs: 1, size: 1, hash: 'qqq' }]
  ])
  const config = baseDecide({ fileStates: new Map([...configChanged, ...artifactStates]) })
  check('a_config_change_invalidates_sandbox_pass', !config.validRunIds.includes('r1'))

  // (e) Only the check's own log/exit artifacts changed → the project inputs
  // are untouched (same input fingerprint), so the run's input binding stays
  // current; the artifact write itself never counts as a task change or as
  // task progress (collector filters it out below).
  const artifactTouched = new Map([...inputA, ...artifactStates])
  artifactTouched.set(`${VERIFY_DIR}/tests-r1.log`, { exists: true, mtimeMs: 99, size: 2, hash: 'changed-log' })
  check('a_artifact_only_change_keeps_input_fingerprint', fpOf(artifactTouched) === fpA)

  // (f) Request identity mismatch (another request's run) → not current evidence.
  const mismatchedRid = baseDecide({
    bundle: emptyBundle({ changedFiles: ['feature.js'], verification: [sandboxRun('r1', 'old-rid', fpA)] }),
    sandboxRequests: new Map([['tests', { rid: 'new-rid', fingerprint: fpA }]])
  })
  check('a_rid_mismatch_invalidates_sandbox_pass', !mismatchedRid.validRunIds.includes('r1'))

  // (g) Malformed sandbox run (claims the sandbox object without request
  // identity or fingerprint) → never current evidence.
  const malformed = { ...sandboxRun('r1', 'r1', fpA), requestId: undefined, inputFingerprint: undefined }
  const malformedDecision = baseDecide({
    bundle: emptyBundle({ changedFiles: ['feature.js'], verification: [malformed] })
  })
  check('a_malformed_sandbox_run_never_current', !malformedDecision.validRunIds.includes('r1'))

  // (h) After the change a real re-check passes: the new run (same check
  // object, new request + fingerprint) is current and supersedes the old pass;
  // the Result shows the old one as history and the new one as current.
  const reRun = sandboxRun('r2', 'r2', fpB, 4)
  const rechecked = baseDecide({
    bundle: emptyBundle({ changedFiles: ['feature.js'], verification: [sandboxRun('r1', 'r1', fpA), reRun] }),
    fileStates: new Map([...inputB, ...reRun.stamps]),
    sandboxRequests: new Map([['tests', { rid: 'r2', fingerprint: fpB }]])
  })
  check('a_recheck_supersedes_old_pass', rechecked.validRunIds.includes('r2') && !rechecked.validRunIds.includes('r1'))
  const { ResultBuilder } = await bundle('src/main/result/ResultBuilder.ts', join(here, '.cache-gate-result.cjs'))
  const recheckDoc = new ResultBuilder().build({
    finalResponse: '', outcome: 'completed',
    evidence: {
      changedFiles: ['feature.js'], turnChangedFiles: [], newFiles: [], deletedFiles: [], preexistingChanges: [],
      toolFacts: [], verification: [sandboxRun('r1', 'r1', fpA), reRun], outcome: 'completed'
    },
    decision: { decision: 'completed', reason: 'r', incomplete: [], knownIssues: [], validRunIds: ['r2'], items: [] },
    round: { mode: 'loop', turns: [{ spec: 'make tests pass', outcome: 'completed', output: '' }] }
  })
  check('a_old_pass_shown_as_history_new_as_current',
    recheckDoc.verification.some((line) => line.includes('历史'))
    && recheckDoc.verification.some((line) => line.includes('DSH 沙盒检查报告；产品核实结果产物及输入快照')))
}

{
  // 4d. TODO 7 §2 A: inputs changing WHILE a sandbox check runs invalidate
  // that round's result — the product re-reads the workspace after the checks
  // and refuses the stale-bound evidence, so the loop must re-request and
  // re-run instead of completing on the first (now stale) pass.
  const ws = await mkdtemp(join(tmpdir(), 'temporal-sandbox-midcheck-'))
  await writeFile(join(ws, 'package.json'), JSON.stringify({ name: 'probe', scripts: { test: 'node feature-check.js' } }))
  await writeFile(join(ws, 'feature-check.js'), 'const fs = require("fs"); if (!fs.existsSync("feature.js")) { console.error("missing feature.js"); process.exit(1) } console.log("feature ok")\n')
  const run = promisify(execFile)
  const prompts = []
  const runtime = {
    prompt: async (promptText) => {
      prompts.push(promptText)
      if (!prompts.some((p) => p.includes('Evidence inventory'))) {
        // First turn: do the work, report incomplete.
        await writeFile(join(ws, 'feature.js'), 'v1\n')
        return { text: incompleteBlock() }
      }
      // Later turns: run the exact wrapper the controller told us to run.
      const match = promptText.match(/cmd \/c (temporal-verify\\[\w-]+\.cmd)/)
      if (match) await run('cmd', ['/c', match[1]], { cwd: ws, windowsHide: true })
      const ids = [...promptText.matchAll(/^- (e\d+):/gm)].map((m) => m[1])
      return { text: completedBlock(ids.length > 0 ? [ids[ids.length - 1]] : []) }
    },
    takeToolFacts: () => []
  }
  let checksRun = 0
  const verify = async (request) => {
    checksRun += 1
    // The FIRST sandbox check execution happens while an external actor (here
    // the probe) changes the project input: the check was requested against
    // the v1 snapshot, so its outcome must not support completion.
    if (checksRun === 1) await writeFile(join(ws, 'feature.js'), 'v2\n')
    return executor.run(request)
  }
  const controller = new LoopController(runtime, new EvidenceCollector(), { ...DEFAULT_LOOP_BUDGET, maxContinuations: 8, maxNoProgress: 5 }, Date.now, verify)
  const result = await controller.run({
    rootSpec: 'Add a feature and make sure the tests pass',
    workspacePath: ws, permission: 'workspace-write', takeEvents: () => []
  })
  // The first pass (bound to the v1 snapshot) was invalidated by the mid-check
  // input change, so the loop re-requested the check on the current snapshot
  // and only then completed.
  check('mid_check_input_change_forces_rerun', result.terminal.status === 'completed' && checksRun >= 2)
  const currentRuns = new Set(result.decision?.validRunIds ?? [])
  const invalidatedSandbox = result.evidence.verification.filter((r) => r.checkObject === 'sandbox:tests' && !currentRuns.has(r.id))
  check('mid_check_stale_evidence_not_current', invalidatedSandbox.length >= 1)
  await rm(ws, { recursive: true, force: true }).catch(() => {})
}

{
  // 4e. TODO 7 §2 A: the product's verification artifacts (`temporal-verify`)
  // are product material — writing or rewriting them is never a task change,
  // task progress, or a Result artifact. The input fingerprint is invariant
  // to artifact writes, so a check can never invalidate itself.
  const ws = await mkdtemp(join(tmpdir(), 'temporal-artifact-excl-'))
  await writeFile(join(ws, 'src.js'), 'x\n')
  const collector = new EvidenceCollector()
  const start = await collector.baseline(ws)
  // The model "runs the wrapper": it writes its log/exit artifacts.
  await mkdir(join(ws, VERIFY_DIR), { recursive: true })
  await writeFile(join(ws, VERIFY_DIR, 'tests-a1.exit'), '0\n')
  await writeFile(join(ws, VERIFY_DIR, 'tests-a1.log'), 'all tests passed\n')
  const { bundle, snapshot } = await collector.collect(ws, start, start, [], [], 'completed')
  check('artifact_files_not_task_changes',
    !bundle.changedFiles.some((file) => file.startsWith(`${VERIFY_DIR}/`))
    && !bundle.turnChangedFiles.some((file) => file.startsWith(`${VERIFY_DIR}/`))
    && !bundle.newFiles.some((file) => file.startsWith(`${VERIFY_DIR}/`)))
  // A real task file still counts as a change.
  await writeFile(join(ws, 'src.js'), 'y\n')
  const { bundle: bundle2 } = await collector.collect(ws, start, snapshot, [], [], 'completed')
  check('task_file_still_counts_as_change', bundle2.changedFiles.includes('src.js'))
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
    {
      baseline: async () => emptySnapshot(),
      collect: async () => ({ bundle: emptyBundle(), snapshot: emptySnapshot() }),
      currentFileStates: async () => emptySnapshot().fileStates
    },
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
      },
      currentFileStates: async () => emptySnapshot().fileStates
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
      },
      currentFileStates: async () => emptySnapshot().fileStates
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
