/**
 * Phase 2 acceptance probe: the four-condition Loop completion gate.
 *
 * Counterexamples that must NOT complete, plus the positive path. Every case
 * drives the REAL evaluator/collector/controller; verdicts are never fabricated
 * as passed. Run under Electron's Node:
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

const { LoopEvaluator } = await bundle('src/main/loop/LoopEvaluator.ts', join(here, '.cache-gate-evaluator.cjs'))
const { LoopController, DEFAULT_LOOP_BUDGET } = await bundle('src/main/loop/LoopController.ts', join(here, '.cache-gate-loop.cjs'))
const { EvidenceCollector } = await bundle('src/main/evidence/EvidenceCollector.ts', join(here, '.cache-gate-evidence.cjs'))
const { VerificationExecutor } = await bundle('src/main/evidence/VerificationExecutor.ts', join(here, '.cache-gate-verify.cjs'))
const { ResultBuilder } = await bundle('src/main/result/ResultBuilder.ts', join(here, '.cache-gate-result.cjs'))

const checks = {}
const check = (name, value) => { checks[name] = Boolean(value) }

// ---------------------------------------------------------------------------
// Helpers: build runs/bundles/file states for the evaluator.
// ---------------------------------------------------------------------------
const iso = () => new Date().toISOString()
function stamp(exists, mtimeMs, size) { return { exists, mtimeMs, size } }
function fileStates(entries) { const m = new Map(); for (const [k, v] of Object.entries(entries)) m.set(k, v); return m }
function run(overrides) {
  return {
    id: 'r-1', turn: 1, label: 'check', command: 'cmd /c check', exitCode: 0, signal: null, outputTail: '',
    scope: 'file', targets: [], covers: [], stamps: new Map(), outcome: 'passed', at: iso(), ...overrides
  }
}
function mkBundle(overrides) {
  return { changedFiles: [], turnChangedFiles: [], newFiles: [], preexistingChanges: [], toolFacts: [], verification: [], outcome: 'completed', ...overrides }
}
function decide(input) {
  const evaluator = new LoopEvaluator()
  return evaluator.decide({ rootSpec: input.spec, bundle: input.bundle, fileStates: input.fileStates, changedTurnByFile: input.changedTurnByFile ?? new Map(), turn: input.turn ?? 1 })
}
function item(decision, id) { return decision.items.find((i) => i.id === id) }

// --- 1. A+B, only A done with passing tests 鈫?must not complete ------------
{
  const spec = 'Create file a.txt.\nCreate file b.txt.'
  const d = decide({
    spec,
    bundle: mkBundle({
      changedFiles: ['a.txt'],
      verification: [run({ id: 'rA', covers: ['req-1'], targets: ['a.txt'], stamps: new Map([['a.txt', stamp(true, 100, 5)]]), exitCode: 0, outcome: 'passed' })]
    }),
    fileStates: fileStates({ 'a.txt': stamp(true, 100, 5) })
  })
  check('gate_A_plus_B_only_A', d.decision !== 'completed' && item(d, 'req-2').status === 'pending')
}

// --- 2. Only irrelevant tests passing 鈫?must not complete -------------------
{
  const spec = 'Implement feature X.'
  const d = decide({
    spec,
    bundle: mkBundle({
      changedFiles: ['src/x.ts'],
      verification: [run({ id: 'rI', covers: ['req-1'], targets: ['tests/unrelated.test.js'], stamps: new Map([['tests/unrelated.test.js', stamp(true, 100, 5)]]), exitCode: 0, outcome: 'passed' })]
    }),
    fileStates: fileStates({ 'src/x.ts': stamp(true, 100, 5), 'tests/unrelated.test.js': stamp(true, 100, 5) })
  })
  check('gate_irrelevant_tests_only', d.decision !== 'completed' && item(d, 'req-1').status === 'pending')
}

// --- 3. Missing reliable result (no exit code) 鈫?observed, not passed -------
{
  const spec = 'Create file a.txt.'
  const d = decide({
    spec,
    bundle: mkBundle({
      changedFiles: ['a.txt'],
      verification: [run({ id: 'rO', covers: ['req-1'], targets: ['a.txt'], stamps: new Map([['a.txt', stamp(true, 100, 5)]]), exitCode: null, outcome: 'observed' })]
    }),
    fileStates: fileStates({ 'a.txt': stamp(true, 100, 5) })
  })
  check('gate_no_exit_code_unknown', d.decision !== 'completed' && item(d, 'req-1').status === 'unknown')
}

// --- 4. Evidence referencing a nonexistent requirement 鈫?real item pending --
{
  const spec = 'Create file a.txt.'
  const d = decide({
    spec,
    bundle: mkBundle({
      changedFiles: ['a.txt'],
      verification: [run({ id: 'rG', covers: ['req-99'], targets: ['a.txt'], stamps: new Map([['a.txt', stamp(true, 100, 5)]]), exitCode: 0, outcome: 'passed' })]
    }),
    fileStates: fileStates({ 'a.txt': stamp(true, 100, 5) })
  })
  check('gate_nonexistent_coverage_id', d.decision !== 'completed' && item(d, 'req-1').status === 'pending')
}

// --- 5. Verification passed, then the file was modified 鈫?invalidated -------
{
  const spec = 'Create file a.txt.'
  const d = decide({
    spec,
    bundle: mkBundle({
      changedFiles: ['a.txt'],
      verification: [run({ id: 'rM', turn: 1, covers: ['req-1'], targets: ['a.txt'], stamps: new Map([['a.txt', stamp(true, 100, 5)]]), exitCode: 0, outcome: 'passed' })]
    }),
    fileStates: fileStates({ 'a.txt': stamp(true, 200, 5) }),
    changedTurnByFile: new Map([['a.txt', 2]]),
    turn: 2
  })
  check('gate_modified_after_verify_invalid', d.decision !== 'completed' && item(d, 'req-1').status === 'pending')
}

// --- 6. Verification passed, then the artifact was deleted 鈫?invalidated ----
{
  const spec = 'Create file a.txt.'
  const d = decide({
    spec,
    bundle: mkBundle({
      changedFiles: ['a.txt'],
      verification: [run({ id: 'rD', turn: 1, covers: ['req-1'], targets: ['a.txt'], stamps: new Map([['a.txt', stamp(true, 100, 5)]]), exitCode: 0, outcome: 'passed' })]
    }),
    fileStates: fileStates({ 'a.txt': stamp(false, 0, 0) })
  })
  check('gate_artifact_deleted_invalid', d.decision !== 'completed' && item(d, 'req-1').status === 'pending')
}

// --- 7. Passed check plus an unresolved failed check 鈫?blocked from completed
{
  const spec = 'Create file a.txt.'
  const d = decide({
    spec,
    bundle: mkBundle({
      changedFiles: ['a.txt'],
      verification: [
        run({ id: 'rOk', covers: ['req-1'], targets: ['a.txt'], stamps: new Map([['a.txt', stamp(true, 100, 5)]]), exitCode: 0, outcome: 'passed' }),
        run({ id: 'rBad', covers: ['req-1'], targets: ['a.txt'], stamps: new Map([['a.txt', stamp(true, 100, 5)]]), exitCode: 1, outcome: 'failed' })
      ]
    }),
    fileStates: fileStates({ 'a.txt': stamp(true, 100, 5) })
  })
  check('gate_unresolved_failed_check', d.decision !== 'completed' && d.knownIssues.some((issue) => issue.includes('failed')))
}

// --- 8. Long spec: a trailing requirement is retained ------------------------
{
  const lines = Array.from({ length: 40 }, (_, i) => `Create file f${i + 1}.txt.`)
  const spec = lines.join('\n')
  const changedFiles = lines.slice(0, 39).map((_, i) => `f${i + 1}.txt`)
  const verification = changedFiles.map((file, i) =>
    run({ id: `r${i + 1}`, covers: [`req-${i + 1}`], targets: [file], stamps: new Map([[file, stamp(true, 100, 5)]]), exitCode: 0, outcome: 'passed' })
  )
  const states = Object.fromEntries(changedFiles.map((f) => [f, stamp(true, 100, 5)]))
  const d = decide({ spec, bundle: mkBundle({ changedFiles, verification }), fileStates: fileStates(states) })
  check('gate_trailing_requirement_kept', d.decision !== 'completed' && d.items.length === 40 && item(d, 'req-40').status === 'pending')
}

// --- 9. Completion is decided by evidence, never by the model's words -------
{
  const spec = 'Create file a.txt.'
  const noEvidence = decide({ spec, bundle: mkBundle({ changedFiles: ['a.txt'] }), fileStates: fileStates({ 'a.txt': stamp(true, 100, 5) }) })
  check('gate_done_words_need_evidence', noEvidence.decision !== 'completed')
  const full = decide({
    spec,
    bundle: mkBundle({
      changedFiles: ['a.txt'],
      verification: [run({ id: 'rP', covers: ['req-1'], targets: ['a.txt'], stamps: new Map([['a.txt', stamp(true, 100, 5)]]), exitCode: 0, outcome: 'passed' })]
    }),
    fileStates: fileStates({ 'a.txt': stamp(true, 100, 5) })
  })
  // `decide` receives no model text at all, so it can neither accept nor reject on words.
  check('gate_positive_completes', full.decision === 'completed' && full.reason.includes('req-1'))
}

// --- DSH tool failure with no later success is a known issue ----------------
{
  const spec = 'Create file a.txt.'
  const d = decide({
    spec,
    bundle: mkBundle({
      changedFiles: ['a.txt'],
      toolFacts: [{ toolCallId: 't1', turn: 1, title: 'pwsh', kind: 'other', status: 'failed', at: iso() }],
      verification: [run({ id: 'rT', covers: ['req-1'], targets: ['a.txt'], stamps: new Map([['a.txt', stamp(true, 100, 5)]]), exitCode: 0, outcome: 'passed' })]
    }),
    fileStates: fileStates({ 'a.txt': stamp(true, 100, 5) })
  })
  check('gate_failed_tool_blocks', d.decision !== 'completed' && d.knownIssues.some((issue) => issue.includes('pwsh')))
  const recovered = decide({
    spec,
    bundle: mkBundle({
      changedFiles: ['a.txt'],
      toolFacts: [
        { toolCallId: 't1', turn: 1, title: 'pwsh', kind: 'other', status: 'failed', at: iso() },
        { toolCallId: 't2', turn: 1, title: 'pwsh', kind: 'other', status: 'completed', at: new Date(Date.now() + 1).toISOString() }
      ],
      verification: [run({ id: 'rT2', covers: ['req-1'], targets: ['a.txt'], stamps: new Map([['a.txt', stamp(true, 100, 5)]]), exitCode: 0, outcome: 'passed' })]
    }),
    fileStates: fileStates({ 'a.txt': stamp(true, 100, 5) })
  })
  check('gate_recovered_tool_not_blocking', recovered.decision === 'completed')
}

// ---------------------------------------------------------------------------
// Controller level: an irrelevant "passing" run + a missing required artifact
// must not complete, and the Result must tell the truth.
// ---------------------------------------------------------------------------
{
  const root = await mkdtemp(join(tmpdir(), 'temporal-gate-ctrl-'))
  const runtime = {
    prompt: async () => {
      await mkdir(join(root, 'tests'), { recursive: true })
      await writeFile(join(root, 'tests', 'unrelated.txt'), 'x')
      return { text: 'done' }
    }
  }
  const controller = new LoopController(runtime, new EvidenceCollector(), DEFAULT_LOOP_BUDGET, Date.now, new VerificationExecutor().run)
  const spec = 'Create a file src/feature.txt.\nRun: cmd /c exit 0'
  const result = await controller.run({ rootSpec: spec, workspacePath: root, takeEvents: () => [] })
  check('controller_incomplete_not_completed', result.terminal.status !== 'completed')

  const document = new ResultBuilder().build({
    finalResponse: result.finalResponse,
    evidence: result.evidence,
    outcome: result.terminal.status === 'completed' ? 'completed' : 'failed',
    loopTerminal: result.terminal,
    decision: result.decision
  })
  check('result_reports_remaining_requirement', document.remaining.some((line) => line.includes('req-1') || line.includes('未覆盖')))
  check('result_no_fake_passed', !document.verification.some((line) => line.includes('req-1')))
}

// ---------------------------------------------------------------------------
// Result truthfulness at the builder level: unknown/observed is never passed.
// ---------------------------------------------------------------------------
{
  const builder = new ResultBuilder()
  const observed = builder.build({
    finalResponse: 'It passed.',
    evidence: mkBundle({ verification: [run({ id: 'rO2', covers: ['req-1'], targets: ['a.txt'], exitCode: null, outcome: 'observed' })] }),
    outcome: 'failed',
    loopTerminal: { status: 'failed', reason: 'No progress after 3 consecutive continuations.' }
  })
  check('result_observed_not_shown_passed', observed.verification.length === 0 && observed.remaining.some((line) => line.includes('No progress')))
}

const passed = Object.values(checks).every(Boolean)
console.log(JSON.stringify({ checks, passed }, null, 2))
if (!passed) process.exitCode = 1
