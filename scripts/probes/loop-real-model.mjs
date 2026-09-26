/**
 * TODO 6 §3 acceptance probe: the natural-language loop with a REAL model.
 * Formal path only: WindowController → RoundEngine → LoopController →
 * DshRuntime (real DSH) → EvidenceCollector → VerificationExecutor →
 * ResultBuilder. Credentials come from the environment and are never printed.
 *
 * Scenarios:
 *  A. A real natural-language code task (long Markdown with headings, a code
 *     block and a trailing requirement): fix the `add` bug so the test script
 *     passes — NOT phrased with any parser keyword. Under workspace-write the
 *     test script is verified through the product-written sandbox wrapper the
 *     model runs inside DSH; the product reads the real exit artifact. The
 *     tests folder must remain untouched.
 *  B. A non-code task (write a document): completes with adapted evidence.
 *  C. Deterministic half-done work (scripted model, real collector and
 *     executor): some checks pass but the tests still fail — the loop must
 *     never complete and must name the gap.
 *
 * Run: node scripts/probes/loop-real-model.mjs
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

const provider = process.env.TEMPORAL_TEST_PROVIDER ?? 'volc-ark'
const model = process.env.TEMPORAL_TEST_MODEL ?? 'deepseek-v4-flash'
const baseUrl = process.env.TEMPORAL_TEST_BASE_URL ?? 'https://ark.cn-beijing.volces.com/api/plan/v3'
const credential = process.env.TEMPORAL_TEST_API_KEY ?? process.env.DEEPSEEK_API_KEY ?? process.env.VOLC_ARK_API_KEY
if (!credential) {
  console.log(JSON.stringify({ status: 'skipped', reason: 'no credential in env' }))
  process.exit(2)
}

const electronStub = join(here, '.cache-loopreal-electron.cjs')
await writeFile(electronStub, [
  'exports.safeStorage = {',
  '  isEncryptionAvailable: () => true,',
  '  encryptString: (value) => Buffer.from(String(value), "utf8"),',
  '  decryptString: (buffer) => buffer.toString("utf8")',
  '}'
].join('\n'))

async function bundle(entry, outfile) {
  await esbuild.build({
    entryPoints: [join(repoRoot, entry)], bundle: true, platform: 'node', format: 'cjs',
    outfile, external: [], logLevel: 'silent', alias: { electron: electronStub }
  })
  return require(outfile)
}

const { WindowController } = await bundle('src/main/WindowController.ts', join(here, '.cache-loopreal-controller.cjs'))
const { ProductStore } = await bundle('src/main/persistence/ProductStore.ts', join(here, '.cache-loopreal-store.cjs'))
const { CredentialVault } = await bundle('src/main/settings/CredentialVault.ts', join(here, '.cache-loopreal-vault.cjs'))
const { LoopController, DEFAULT_LOOP_BUDGET } = await bundle('src/main/loop/LoopController.ts', join(here, '.cache-loopreal-loop.cjs'))
const { EvidenceCollector } = await bundle('src/main/evidence/EvidenceCollector.ts', join(here, '.cache-loopreal-evidence.cjs'))
const { VerificationExecutor } = await bundle('src/main/evidence/VerificationExecutor.ts', join(here, '.cache-loopreal-verify.cjs'))

const checks = {}
const check = (name, value) => { checks[name] = Boolean(value) }
const run = promisify(execFile)
const tempRoot = await mkdtemp(join(tmpdir(), 'temporal-loopreal-'))
process.env.DSH_HOME = join(tempRoot, 'dsh-home')

/** A small real project with a genuine bug in `add`. */
async function makeProject(name) {
  const ws = join(tempRoot, name)
  await mkdir(join(ws, 'tests'), { recursive: true })
  await run('git', ['-C', tempRoot, 'init', ws], { windowsHide: true })
  await run('git', ['-C', ws, 'config', 'user.email', 'probe@example.invalid'], { windowsHide: true })
  await run('git', ['-C', ws, 'config', 'user.name', 'probe'], { windowsHide: true })
  await writeFile(join(ws, 'package.json'), JSON.stringify({ name: 'calc-app', version: '1.0.0', scripts: { test: 'node tests/run.js' } }, null, 2))
  await writeFile(join(ws, 'calc.js'), [
    'function add(a, b) {',
    '  return a - b',
    '}',
    'function multiply(a, b) {',
    '  return a * b',
    '}',
    'module.exports = { add, multiply }',
    ''
  ].join('\n'))
  await writeFile(join(ws, 'tests', 'run.js'), [
    "const assert = require('node:assert')",
    "const { add, multiply } = require('../calc.js')",
    'assert.strictEqual(add(2, 3), 5)',
    'assert.strictEqual(add(-1, 1), 0)',
    'assert.strictEqual(multiply(2, 3), 6)',
    "console.log('ALL TESTS PASSED')",
    ''
  ].join('\n'))
  await run('git', ['-C', ws, 'add', '.'], { windowsHide: true })
  await run('git', ['-C', ws, 'commit', '-m', 'baseline'], { windowsHide: true })
  return ws
}

const FIX_SPEC = [
  '# Fix the calculator',
  '',
  'Our tiny calculator project is broken.',
  '',
  '## The bug',
  '',
  'The file `calc.js` exports `add(a, b)`, but it returns the wrong number:',
  'calling `add(2, 3)` must return `5`, and `add(-1, 1)` must return `0`.',
  '',
  '```js',
  '// the wrong implementation lives in calc.js right now',
  'const result = add(2, 3) // must become 5',
  '```',
  '',
  '## What to do',
  '',
  '- Fix `add` in `calc.js` so that every check in `tests/run.js` passes.',
  '- Do not modify anything inside the `tests` folder.',
  '- Keep `multiply` exactly as it is.',
  '',
  'When you are done, run the project test script and make sure it really passes.'
].join('\n')

const DOC_SPEC = [
  '# Document the helper',
  '',
  'Create a file named NOTES.md in the workspace root.',
  'It must contain one short paragraph of at least 200 characters describing',
  'what calc.js and tests/run.js are for, so that a new contributor can get',
  'started quickly.'
].join('\n')

// ===========================================================================
// A. Real code task through the full formal path
// ===========================================================================
{
  const ws = await makeProject('ws-code')
  const dbPath = join(tempRoot, 'code.sqlite')
  const controller = new WindowController(
    { isDestroyed: () => false, webContents: { send: () => {} } },
    new ProductStore(dbPath),
    new CredentialVault(join(tempRoot, 'vault-code.bin'))
  )
  const storeProbe = new ProductStore(dbPath)
  try {
    await controller.saveModelSettings({ provider, model, baseUrl, credential })
    const opened = await controller.openSession(ws)
    const sessionId = opened.session.id
    await controller.submit(FIX_SPEC, 'loop')

    const rounds = storeProbe.listRounds(sessionId)
    const loopRound = rounds.find((round) => round.mode === 'loop')
    check('code_single_loop_round', rounds.filter((round) => round.mode === 'loop').length === 1)
    check('code_loop_completed', loopRound?.status === 'completed')
    const result = loopRound ? storeProbe.getResult(loopRound.id) : undefined
    check('code_result_terminal_completed', result?.loopTerminal?.status === 'completed')
    console.error('A terminal:', JSON.stringify(result?.loopTerminal))
    console.error('A decision:', JSON.stringify({ reason: result?.decision?.reason, knownIssues: result?.decision?.knownIssues, incomplete: result?.decision?.incomplete }, null, 2))
    console.error('A runs:', JSON.stringify(result?.verification))
    console.error('A remaining:', JSON.stringify(result?.remaining))
    check('code_changes_mention_calc', result?.changes.some((line) => line.startsWith('calc.js ')) === true)
    check('code_tests_untouched', result?.changes.every((line) => !line.startsWith('tests/')) === true)
    check('code_verification_passed_recorded', result?.verification.some((line) => line.includes('passed')) === true)
    check('code_remaining_empty', (result?.remaining ?? []).length === 0)

    const exitArtifact = join(ws, 'temporal-verify', 'tests.exit')
    check('code_sandbox_exit_artifact_exists', existsSync(exitArtifact))
    if (existsSync(exitArtifact)) {
      const content = await readFile(exitArtifact, 'utf8')
      check('code_sandbox_exit_code_zero', content.trim() === '0')
    }
    const calcNow = await readFile(join(ws, 'calc.js'), 'utf8')
    check('code_add_actually_fixed', calcNow.includes('return a + b'))
    const testsNow = await readFile(join(ws, 'tests', 'run.js'), 'utf8')
    check('code_tests_content_intact', testsNow.includes("console.log('ALL TESTS PASSED')"))
  } finally {
    await controller.dispose().catch(() => {})
  }
}

// ===========================================================================
// B. Real non-code task (document) through the full formal path
// ===========================================================================
{
  const ws = await makeProject('ws-doc')
  const dbPath = join(tempRoot, 'doc.sqlite')
  const controller = new WindowController(
    { isDestroyed: () => false, webContents: { send: () => {} } },
    new ProductStore(dbPath),
    new CredentialVault(join(tempRoot, 'vault-doc.bin'))
  )
  const storeProbe = new ProductStore(dbPath)
  try {
    await controller.saveModelSettings({ provider, model, baseUrl, credential })
    const opened = await controller.openSession(ws)
    const sessionId = opened.session.id
    await controller.submit(DOC_SPEC, 'loop')

    const loopRound = storeProbe.listRounds(sessionId).find((round) => round.mode === 'loop')
    const result = loopRound ? storeProbe.getResult(loopRound.id) : undefined
    check('doc_loop_completed', loopRound?.status === 'completed' && result?.loopTerminal?.status === 'completed')
    console.error('B terminal:', JSON.stringify(result?.loopTerminal))
    console.error('B decision:', JSON.stringify({ reason: result?.decision?.reason, knownIssues: result?.decision?.knownIssues, incomplete: result?.decision?.incomplete }, null, 2))
    console.error('B runs:', JSON.stringify(result?.verification))
    const notes = join(ws, 'NOTES.md')
    check('doc_file_created', existsSync(notes))
    if (existsSync(notes)) {
      const content = await readFile(notes, 'utf8')
      check('doc_content_substantive', content.trim().length >= 200)
    }
  } finally {
    await controller.dispose().catch(() => {})
  }
}

// ===========================================================================
// C. Deterministic half-done work: some checks pass, the tests still fail —
//    the loop must never complete and must name the gap.
// ===========================================================================
{
  const ws = await makeProject('ws-half')
  // The scripted model does the easy half (writes FIXNOTES.md) and claims
  // completion citing e1 every turn; it never fixes the bug and never runs
  // the test wrapper. Real collector, real verification executor.
  const block = (citations) => '```temporal-decision\n' + JSON.stringify({
    decision: 'completed', reason: 'done',
    coverage: [{ item: 'everything', status: 'met', evidence: citations }],
    incomplete: [], nextAction: ''
  }) + '\n```'
  let turn = 0
  const runtime = {
    prompt: async () => {
      turn += 1
      await writeFile(join(ws, 'FIXNOTES.md'), 'Explains what was changed.\n')
      return { text: `I finished the task.\n\n${block(['e1'])}` }
    }
  }
  const controller = new LoopController(runtime, new EvidenceCollector(), { ...DEFAULT_LOOP_BUDGET, maxContinuations: 3 }, Date.now, new VerificationExecutor().run)
  const result = await controller.run({
    rootSpec: 'Fix the calculator bug in calc.js so the test script passes, and write FIXNOTES.md describing the change.',
    workspacePath: ws, permission: 'workspace-write', takeEvents: () => []
  })
  check('half_done_never_completes', result.terminal.status !== 'completed')
  check('half_done_names_the_gap', (result.decision?.knownIssues ?? []).some((issue) => issue.toLowerCase().includes('tests')))
  check('half_done_saved_decision', Boolean(result.decision))
  const fixnotes = existsSync(join(ws, 'FIXNOTES.md'))
  check('half_done_easy_part_done', fixnotes)
  const calcNow = await readFile(join(ws, 'calc.js'), 'utf8')
  check('half_done_bug_not_fixed_by_claim', calcNow.includes('return a - b'))
}

await rm(tempRoot, { recursive: true, force: true }).catch(() => {})

const failed = Object.entries(checks).filter(([, ok]) => !ok)
console.log(JSON.stringify({ checks, passed: failed.length === 0, failed: failed.map(([name]) => name) }, null, 2))
process.exit(failed.length === 0 ? 0 : 1)
