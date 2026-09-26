/**
 * Phase A acceptance probe: check facts are strictly separated from
 * requirement assessment. Every counterexample must NOT complete, and every
 * positive must complete, through the REAL collector / verification executor /
 * evaluator / controller paths — coverage is never fabricated through
 * generator-written `covers`.
 *
 * Run under Electron's Node:
 *   $env:ELECTRON_RUN_AS_NODE=1
 *   .\node_modules\electron\dist\electron.exe scripts/probes/loop-gate-impl.mjs
 */
import { createRequire } from 'node:module'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
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

const { LoopEvaluator, EMPTY_HINTS } = await bundle('src/main/loop/LoopEvaluator.ts', join(here, '.cache-gate-evaluator.cjs'))
const { LoopController, DEFAULT_LOOP_BUDGET } = await bundle('src/main/loop/LoopController.ts', join(here, '.cache-gate-loop.cjs'))
const { EvidenceCollector } = await bundle('src/main/evidence/EvidenceCollector.ts', join(here, '.cache-gate-evidence.cjs'))
const { VerificationExecutor } = await bundle('src/main/evidence/VerificationExecutor.ts', join(here, '.cache-gate-verify.cjs'))
const { ResultBuilder } = await bundle('src/main/result/ResultBuilder.ts', join(here, '.cache-gate-result.cjs'))

const checks = {}
const check = (name, value) => { checks[name] = Boolean(value) }

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const iso = () => new Date().toISOString()
function stamp(exists, mtimeMs, size, hash) { return hash ? { exists, mtimeMs, size, hash } : { exists, mtimeMs, size } }
function fileStates(entries) { const m = new Map(); for (const [k, v] of Object.entries(entries)) m.set(k, v); return m }
function fact(overrides) { return { matched: true, ...overrides } }
function run(overrides) {
  return {
    id: 'r-1', turn: 1, label: 'check', method: 'builtin', command: 'builtin:check',
    exitCode: null, signal: null, outputTail: '',
    scope: 'file', targets: [], facts: [], stamps: new Map(), outcome: 'passed', at: iso(), ...overrides
  }
}
function mkBundle(overrides) {
  return { changedFiles: [], turnChangedFiles: [], newFiles: [], preexistingChanges: [], toolFacts: [], verification: [], outcome: 'completed', ...overrides }
}
function decide(input) {
  const evaluator = new LoopEvaluator()
  return evaluator.decide({
    rootSpec: input.spec, bundle: input.bundle, fileStates: input.fileStates,
    changedTurnByFile: input.changedTurnByFile ?? new Map(), turn: input.turn ?? 1,
    hints: input.hints ?? EMPTY_HINTS
  })
}
function item(decision, id) { return decision.items.find((i) => i.id === id) }

// A one-turn fixture loop: `setup` performs the model's workspace writes.
async function controllerRun(spec, setup, options = {}) {
  const root = options.root ?? await mkdtemp(join(tmpdir(), 'temporal-gate-ctrl-'))
  let promptCalls = 0
  const runtime = { prompt: async () => { promptCalls += 1; if (promptCalls === 1 && setup) await setup(root); return { text: 'done' } } }
  const budget = options.budget ?? { ...DEFAULT_LOOP_BUDGET, maxContinuations: 4, maxNoProgress: 2 }
  const controller = new LoopController(runtime, new EvidenceCollector(), budget, Date.now, new VerificationExecutor().run)
  const result = await controller.run({ rootSpec: spec, workspacePath: root, permission: options.permission ?? 'workspace-write', takeEvents: () => [] })
  return { result, root }
}

// ===========================================================================
// Evaluator level: fine-grained condition/fact semantics (unit fixtures).
// ===========================================================================

// --- 1. A+B, only A done → B stays pending, no completion -------------------
{
  const spec = 'Create file a.txt.\nCreate file b.txt.'
  const d = decide({
    spec,
    bundle: mkBundle({
      changedFiles: ['a.txt'],
      verification: [run({
        id: 'rA', label: 'artifact req-1', targets: ['a.txt'],
        stamps: new Map([['a.txt', stamp(true, 100, 5)]]),
        facts: [fact({ kind: 'file-exists', target: 'a.txt', isFile: true })]
      })]
    }),
    fileStates: fileStates({ 'a.txt': stamp(true, 100, 5) })
  })
  check('gate_A_plus_B_only_A', d.decision !== 'completed' && item(d, 'req-2').status === 'pending')
}

// --- 2. A passing check for a path the requirement never mentions -----------
{
  const spec = 'Create file a.txt.'
  const d = decide({
    spec,
    bundle: mkBundle({
      changedFiles: ['b.txt'],
      verification: [run({
        id: 'rX', targets: ['b.txt'],
        stamps: new Map([['b.txt', stamp(true, 100, 5)]]),
        facts: [fact({ kind: 'file-exists', target: 'b.txt', isFile: true })]
      })]
    }),
    fileStates: fileStates({ 'b.txt': stamp(true, 100, 5) })
  })
  check('gate_unrelated_file_fact', d.decision !== 'completed' && item(d, 'req-1').status === 'pending')
}

// --- 3. Behavioral requirement: an unrelated change and unrelated tests -----
{
  const spec = 'Implement feature X.'
  const d = decide({
    spec,
    bundle: mkBundle({
      changedFiles: ['src/x.ts'],
      verification: [run({
        id: 'rI', method: 'shell', command: 'cmd /c npm test', targets: ['tests/unrelated.test.js'], exitCode: 0,
        stamps: new Map([['tests/unrelated.test.js', stamp(true, 100, 5)]]),
        facts: [fact({ kind: 'command-exit', command: 'cmd /c npm test', exitCode: 0 })]
      })]
    }),
    fileStates: fileStates({ 'src/x.ts': stamp(true, 100, 5), 'tests/unrelated.test.js': stamp(true, 100, 5) })
  })
  check('gate_behavioral_unknown', d.decision !== 'completed' && item(d, 'req-1').status === 'unknown')
}

// --- 4. Tests requirement: typecheck alone never covers it ------------------
{
  const spec = 'Add tests and fix the function.'
  const d = decide({
    spec,
    bundle: mkBundle({
      changedFiles: ['src/x.ts'],
      verification: [run({
        id: 'rT', method: 'shell', command: 'cmd /c npm run typecheck', exitCode: 0,
        stamps: new Map([['src/x.ts', stamp(true, 100, 5)]]),
        facts: [fact({ kind: 'command-exit', command: 'cmd /c npm run typecheck', exitCode: 0 })]
      })]
    }),
    fileStates: fileStates({ 'src/x.ts': stamp(true, 100, 5) }),
    hints: { packageJson: true, hasTypecheckScript: true, hasTestScript: true, hasBuildScript: false, tsconfig: true }
  })
  check('gate_typecheck_not_covering_tests', d.decision !== 'completed' && item(d, 'req-1').status === 'pending')
}

// --- 5. Run: exit 0 passes; the neighbouring business requirement stays open
{
  const spec = 'Implement login.\nRun: exit 0'
  const d = decide({
    spec,
    bundle: mkBundle({
      changedFiles: ['src/login.ts'],
      verification: [run({
        id: 'rR', method: 'shell', command: 'cmd /c exit 0', exitCode: 0, scope: 'workspace', targets: ['src/login.ts'],
        stamps: new Map([['src/login.ts', stamp(true, 100, 5)]]),
        facts: [fact({ kind: 'command-exit', command: 'cmd /c exit 0', exitCode: 0 })]
      })]
    }),
    fileStates: fileStates({ 'src/login.ts': stamp(true, 100, 5) })
  })
  check('gate_run_proves_only_itself', d.decision !== 'completed' && item(d, 'req-2').status === 'satisfied' && item(d, 'req-1').status === 'unknown')
}

// --- 6. Verification passed, then the file was modified → invalidated -------
{
  const spec = 'Create file a.txt.'
  const d = decide({
    spec,
    bundle: mkBundle({
      changedFiles: ['a.txt'],
      verification: [run({
        id: 'rM', turn: 1, targets: ['a.txt'],
        stamps: new Map([['a.txt', stamp(true, 100, 5)]]),
        facts: [fact({ kind: 'file-exists', target: 'a.txt', isFile: true })]
      })]
    }),
    fileStates: fileStates({ 'a.txt': stamp(true, 200, 5) }),
    changedTurnByFile: new Map([['a.txt', 2]]),
    turn: 2
  })
  check('gate_modified_after_verify_invalid', d.decision !== 'completed' && item(d, 'req-1').status === 'pending' && d.knownIssues.some((issue) => issue.includes('invalidated')))
}

// --- 7. Same size, same mtime, different content → content hash invalidates
{
  const spec = 'Create file a.txt.'
  const d = decide({
    spec,
    bundle: mkBundle({
      changedFiles: ['a.txt'],
      verification: [run({
        id: 'rH', turn: 1, targets: ['a.txt'],
        stamps: new Map([['a.txt', stamp(true, 100, 5, 'hash-old')]]),
        facts: [fact({ kind: 'file-exists', target: 'a.txt', isFile: true })]
      })]
    }),
    fileStates: fileStates({ 'a.txt': stamp(true, 100, 5, 'hash-new') })
  })
  check('gate_content_hash_invalidates', d.decision !== 'completed' && item(d, 'req-1').status === 'pending')
}

// --- 8. Artifact deleted after the check → invalidated -----------------------
{
  const spec = 'Create file a.txt.'
  const d = decide({
    spec,
    bundle: mkBundle({
      changedFiles: ['a.txt'],
      verification: [run({
        id: 'rD', turn: 1, targets: ['a.txt'],
        stamps: new Map([['a.txt', stamp(true, 100, 5)]]),
        facts: [fact({ kind: 'file-exists', target: 'a.txt', isFile: true })]
      })]
    }),
    fileStates: fileStates({ 'a.txt': stamp(false, 0, 0) })
  })
  check('gate_artifact_deleted_invalid', d.decision !== 'completed' && item(d, 'req-1').status === 'pending')
}

// --- 9. Old failure cleared only by a re-test of the SAME check object ------
{
  const spec = 'Create file a.txt with content E.'
  const common = {
    command: 'builtin:content-equals a.txt', method: 'builtin', targets: ['a.txt'], label: 'content req-1',
    stamps: new Map([['a.txt', stamp(true, 100, 5, 'h')]])
  }
  const fileFact = run({
    id: 'f0', label: 'artifact req-1', command: 'builtin:file-exists a.txt', targets: ['a.txt'],
    stamps: new Map([['a.txt', stamp(true, 100, 5, 'h')]]),
    facts: [fact({ kind: 'file-exists', target: 'a.txt', isFile: true })]
  })
  const fixed = decide({
    spec,
    bundle: mkBundle({
      changedFiles: ['a.txt'],
      verification: [
        fileFact,
        run({ id: 'f1', outcome: 'failed', facts: [fact({ kind: 'content-equals', target: 'a.txt', expectedHash: 'e', actualHash: 'a', matched: false })], ...common }),
        run({ id: 'p1', facts: [fact({ kind: 'content-equals', target: 'a.txt', expectedHash: 'e', actualHash: 'e', matched: true })], ...common })
      ]
    }),
    fileStates: fileStates({ 'a.txt': stamp(true, 100, 5, 'h') })
  })
  check('gate_retest_same_object_clears_failure', fixed.decision === 'completed')
  const unrelated = decide({
    spec,
    bundle: mkBundle({
      changedFiles: ['a.txt'],
      verification: [
        fileFact,
        run({ id: 'f2', outcome: 'failed', facts: [fact({ kind: 'content-equals', target: 'a.txt', expectedHash: 'e', actualHash: 'a', matched: false })], ...common }),
        run({ id: 'p2', command: 'builtin:content-equals b.txt', targets: ['b.txt'], facts: [fact({ kind: 'content-equals', target: 'b.txt', expectedHash: 'e', actualHash: 'e', matched: true })], label: 'other', stamps: new Map([['b.txt', stamp(true, 100, 5)]]) })
      ]
    }),
    fileStates: fileStates({ 'a.txt': stamp(true, 100, 5, 'h'), 'b.txt': stamp(true, 100, 5) })
  })
  check('gate_unrelated_success_not_clearing_failure', unrelated.decision !== 'completed' && unrelated.knownIssues.some((issue) => issue.includes('failed')))
}

// --- 10. Long spec: trailing requirement retained ----------------------------
{
  const lines = Array.from({ length: 40 }, (_, i) => `Create file f${i + 1}.txt.`)
  const spec = lines.join('\n')
  const changedFiles = lines.slice(0, 39).map((_, i) => `f${i + 1}.txt`)
  const verification = changedFiles.map((file, i) =>
    run({ id: `r${i + 1}`, targets: [file], stamps: new Map([[file, stamp(true, 100, 5)]]), facts: [fact({ kind: 'file-exists', target: file, isFile: true })] })
  )
  const states = Object.fromEntries(changedFiles.map((f) => [f, stamp(true, 100, 5)]))
  const d = decide({ spec, bundle: mkBundle({ changedFiles, verification }), fileStates: fileStates(states) })
  check('gate_trailing_requirement_kept', d.decision !== 'completed' && d.items.length === 40 && item(d, 'req-40').status === 'pending')
}

// --- 11. Requirement inside a Markdown heading is not dropped ----------------
{
  const spec = '## Create file a.txt\nSome prose below.'
  const d = decide({
    spec,
    bundle: mkBundle({
      changedFiles: ['a.txt'],
      verification: [run({ id: 'rHead', targets: ['a.txt'], stamps: new Map([['a.txt', stamp(true, 100, 5)]]), facts: [fact({ kind: 'file-exists', target: 'a.txt', isFile: true })] })]
    }),
    fileStates: fileStates({ 'a.txt': stamp(true, 100, 5) })
  })
  const headingItem = d.items.find((i) => i.original.includes('Create file a.txt'))
  check('gate_heading_requirement_kept', Boolean(headingItem) && headingItem.conditions.length > 0)
}

// --- 12. Fenced code blocks are never misparsed as acceptance commands -------
{
  const spec = 'Create file a.txt.\n```\nRun: format c:\n```\n'
  const d = decide({ spec, bundle: mkBundle({ changedFiles: ['a.txt'] }), fileStates: fileStates({ 'a.txt': stamp(true, 100, 5) }) })
  const commandItems = d.items.filter((i) => i.conditions.some((c) => c.kind === 'command'))
  check('gate_fence_not_parsed_as_command', commandItems.length === 0 && d.items.length === 1 && item(d, 'req-1').status === 'pending')
}

// --- 13. DSH tool failure: recovered only by a later success of the same tool
{
  const spec = 'Create file a.txt.'
  const base = {
    changedFiles: ['a.txt'],
    verification: [run({ id: 'rT', targets: ['a.txt'], stamps: new Map([['a.txt', stamp(true, 100, 5)]]), facts: [fact({ kind: 'file-exists', target: 'a.txt', isFile: true })] })]
  }
  const d = decide({
    spec,
    bundle: mkBundle({ ...base, toolFacts: [{ toolCallId: 't1', turn: 1, title: 'pwsh', kind: 'other', status: 'failed', at: iso() }] }),
    fileStates: fileStates({ 'a.txt': stamp(true, 100, 5) })
  })
  check('gate_failed_tool_blocks', d.decision !== 'completed' && d.knownIssues.some((issue) => issue.includes('pwsh')))
  const recovered = decide({
    spec,
    bundle: mkBundle({
      ...base,
      toolFacts: [
        { toolCallId: 't1', turn: 1, title: 'pwsh', kind: 'other', status: 'failed', at: iso() },
        { toolCallId: 't2', turn: 1, title: 'pwsh', kind: 'other', status: 'completed', at: new Date(Date.now() + 1).toISOString() }
      ]
    }),
    fileStates: fileStates({ 'a.txt': stamp(true, 100, 5) })
  })
  check('gate_recovered_tool_not_blocking', recovered.decision === 'completed')
}

// ===========================================================================
// Integration level: real collector + real executor + real controller.
// ===========================================================================

// --- I1. Positive: content requirement completes on real content evidence ---
{
  const { result } = await controllerRun(
    'Create a file named answer.txt whose contents are exactly: verify',
    async (root) => { await writeFile(join(root, 'answer.txt'), 'verify\n') }
  )
  check('loop_content_task_completes', result.terminal.status === 'completed' && result.terminal.reason.includes('req-1'))
  check('loop_content_fact_recorded', result.evidence.verification.some(
    (r) => r.outcome === 'passed' && r.facts.some((f) => f.kind === 'content-equals' && f.matched && f.target === 'answer.txt')
  ))
}

// --- I1b. Positive: explicit behavior-test task completes on a real test run
{
  const root = await mkdtemp(join(tmpdir(), 'temporal-gate-test-'))
  await writeFile(join(root, 'package.json'), JSON.stringify({ scripts: { test: 'node test.js' } }))
  const { result } = await controllerRun(
    'Add a unit test file and make the tests pass.',
    async (ws) => { await writeFile(join(ws, 'test.js'), 'process.exit(0)\n') },
    { root, permission: 'danger-full-access' }
  )
  check('loop_behavior_test_task_completes', result.terminal.status === 'completed' && result.terminal.reason.includes('req-1'))
  check('loop_behavior_test_fact_recorded', result.evidence.verification.some(
    (r) => r.method === 'shell' && r.outcome === 'passed' && r.facts.some((f) => f.kind === 'command-exit' && f.command === 'cmd /c npm test' && f.exitCode === 0)
  ))
}

// --- I2. Content written but WRONG → never completed -------------------------
{
  const { result } = await controllerRun(
    'Create a file named answer.txt whose contents are exactly: XYZ',
    async (root) => { await writeFile(join(root, 'answer.txt'), 'ABC\n') }
  )
  check('loop_wrong_content_not_completed', result.terminal.status === 'failed' && !result.decision?.items.every((i) => i.status === 'satisfied'))
  check('loop_wrong_content_reported', (result.decision?.incomplete.join(' ') ?? '').includes('content'))
  check('loop_wrong_content_no_passed_fact', !result.evidence.verification.some((r) => r.facts.some((f) => f.kind === 'content-equals' && f.matched)))
}

// --- I3. Same-named DIRECTORY cannot satisfy a file requirement --------------
{
  const { result } = await controllerRun(
    'Create a file named thing.txt.',
    async (root) => { await mkdir(join(root, 'thing.txt')) }
  )
  check('loop_directory_not_a_file', result.terminal.status === 'failed')
  check('loop_directory_reported', result.evidence.verification.some(
    (r) => r.outcome === 'failed' && r.facts.some((f) => f.kind === 'file-exists' && !f.isFile)
  ))
}

// --- I4. Same-line two files, only one created → second stays uncovered ------
{
  const { result } = await controllerRun(
    'Create files a.txt and b.txt.',
    async (root) => { await writeFile(join(root, 'a.txt'), 'x') }
  )
  const items = result.decision?.items ?? []
  const b = items.find((i) => i.original.includes('b.txt'))
  check('loop_second_file_missing_not_completed', result.terminal.status === 'failed' && Boolean(b) && b.status !== 'satisfied')
}

// --- I5. JSON field wrong value → never completed ----------------------------
{
  const { result } = await controllerRun(
    'Create a file named settings.json with field enabled=true.',
    async (root) => { await writeFile(join(root, 'settings.json'), '{}\n') }
  )
  check('loop_wrong_field_not_completed', result.terminal.status === 'failed')
  check('loop_wrong_field_reported', (result.decision?.incomplete.join(' ') ?? '').includes('enabled'))
}

// --- I6. Behavioral requirement: unrelated file change never satisfies it ----
{
  const { result } = await controllerRun(
    'Implement login.',
    async (root) => { await writeFile(join(root, 'NOTES.md'), 'unrelated') }
  )
  check('loop_behavioral_unknown_not_completed', result.terminal.status === 'failed' && item(result.decision, 'req-1')?.status === 'unknown')
  check('loop_behavioral_no_fabricated_pass', !result.evidence.verification.some((r) => r.outcome === 'passed'))
}

// --- I7. Run: exit 0 passes (full-access session), business requirement open -
{
  const { result } = await controllerRun(
    'Implement login.\nRun: exit 0',
    async (root) => { await writeFile(join(root, 'NOTES.md'), 'unrelated') },
    { permission: 'danger-full-access' }
  )
  const items = result.decision?.items ?? []
  const runItem = items.find((i) => i.original.includes('Run:'))
  check('loop_run_exit0_only_proves_itself', result.terminal.status === 'failed' && runItem?.status === 'satisfied' && item(result.decision, 'req-1')?.status === 'unknown')
}

// --- I8. Shell acceptance denied under workspace-write (fail closed) ---------
{
  const { result } = await controllerRun(
    'Create a file named answer.txt whose contents are exactly: verify\nRun: type answer.txt',
    async (root) => { await writeFile(join(root, 'answer.txt'), 'verify\n') }
  )
  check('loop_shell_denied_under_workspace_write', result.terminal.status === 'failed')
  check('loop_shell_denial_recorded', result.evidence.verification.some((r) => r.outcome === 'denied' && (r.denial ?? '').includes('workspace-write')))
  const document = new ResultBuilder().build({
    finalResponse: result.finalResponse,
    evidence: result.evidence,
    outcome: 'failed',
    loopTerminal: result.terminal,
    decision: result.decision
  })
  check('result_denied_is_actionable', document.remaining.some((line) => line.includes('denied')))
  check('result_content_fact_shown_passed', document.verification.some((line) => line.includes('content match')))
}

// --- I9. Result truthfulness at the builder level ----------------------------
{
  const builder = new ResultBuilder()
  const observed = builder.build({
    finalResponse: 'It passed.',
    evidence: mkBundle({ verification: [run({ id: 'rO2', outcome: 'observed', exitCode: null, facts: [], targets: ['a.txt'] })] }),
    outcome: 'failed',
    loopTerminal: { status: 'failed', reason: 'No progress after 3 consecutive continuations.' }
  })
  check('result_observed_not_shown_passed', observed.verification.length === 0 && observed.remaining.some((line) => line.includes('No progress')))
  const completed = builder.build({
    finalResponse: 'done',
    evidence: mkBundle({
      changedFiles: ['a.txt'],
      verification: [run({ id: 'rC1', targets: ['a.txt'], stamps: new Map([['a.txt', stamp(true, 100, 5)]]), facts: [fact({ kind: 'file-exists', target: 'a.txt', isFile: true })] })]
    }),
    outcome: 'completed',
    loopTerminal: { status: 'completed', reason: 'covered' },
    decision: { decision: 'completed', reason: 'covered', items: [], incomplete: [], knownIssues: [], nextPrompt: '', nextChecks: [] }
  })
  check('result_builtin_passed_detail', completed.verification[0].includes('file exists'))
}

const passed = Object.values(checks).every(Boolean)
console.log(JSON.stringify({ checks, passed }, null, 2))
if (!passed) process.exitCode = 1
