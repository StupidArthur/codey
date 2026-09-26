/**
 * TODO 6 §2 acceptance probe: Plan behavior through real controller paths
 * with a real model.
 *
 *  - a Plan turn produces a plan (references the target) and does not
 *    implement it (the target file must not exist afterwards)
 *  - Plan × N stays one Round with one version per submit
 *  - switching to Vibe finalizes the Plan round, keeps the same DSH session
 *    (context preserved) and actually implements the requirement
 *
 * Run: node scripts/probes/plan-behavior.mjs
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createRequire } from 'node:module'
import { mkdtemp, rm, writeFile, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'

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

const electronStub = join(here, '.cache-planbeh-electron.cjs')
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

const { WindowController } = await bundle('src/main/WindowController.ts', join(here, '.cache-planbeh-controller.cjs'))
const { ProductStore } = await bundle('src/main/persistence/ProductStore.ts', join(here, '.cache-planbeh-store.cjs'))
const { CredentialVault } = await bundle('src/main/settings/CredentialVault.ts', join(here, '.cache-planbeh-vault.cjs'))

const checks = {}
const check = (name, value) => { checks[name] = Boolean(value) }
const fileExists = async (path) => { try { await access(path); return true } catch { return false } }

const tempRoot = await mkdtemp(join(tmpdir(), 'temporal-planbeh-'))
process.env.DSH_HOME = join(tempRoot, 'dsh-home')

const dbPath = join(tempRoot, 'probe.sqlite')
const controller = new WindowController(
  { isDestroyed: () => false, webContents: { send: () => {} } },
  new ProductStore(dbPath),
  new CredentialVault(join(tempRoot, 'vault.bin'))
)
// Assertion-side store on the same database: the same state the app would see.
const storeProbe = new ProductStore(dbPath)

try {
  const ws = join(tempRoot, 'ws')
  await promisify(execFile)('git', ['-C', tempRoot, 'init', ws], { windowsHide: true })
  await writeFile(join(ws, 'readme.txt'), 'probe workspace\n')

  await controller.saveModelSettings({ provider, model, baseUrl, credential })
  const opened = await controller.openSession(ws)
  const sessionId = opened.session.id
  const tag = randomUUID().replaceAll('-', '').slice(0, 8).toUpperCase()
  const target = 'plan-target.txt'

  // --- Plan turn 1: plans, does not implement -----------------------------
  await controller.submit(`Create a file named ${target} whose contents are exactly ${tag}`, 'plan')
  let rounds = storeProbe.listRoundDetails(sessionId)
  const planRound = rounds.find((round) => round.mode === 'plan')
  check('plan_round_created', Boolean(planRound))
  const version1 = planRound?.planVersions ?? []
  check('plan_one_version', version1.length === 1)
  check('plan_stores_original_spec_verbatim', version1[0]?.submittedSpec === `Create a file named ${target} whose contents are exactly ${tag}`)
  check('plan_markdown_references_target', typeof version1[0]?.planMarkdown === 'string' && version1[0].planMarkdown.includes(target) && version1[0].planMarkdown.trim().length > 40)
  check('plan_turn_did_not_implement', !(await fileExists(join(ws, target))))
  const dshAfterPlan = storeProbe.getSession(sessionId)?.dshSessionId

  // --- Plan × N: same round, second version -------------------------------
  await controller.submit(`Also plan how to verify ${target} after creation`, 'plan')
  rounds = storeProbe.listRoundDetails(sessionId)
  const planVersions = rounds.find((round) => round.mode === 'plan')?.planVersions ?? []
  check('plan_reuses_round_two_versions', rounds.filter((round) => round.mode === 'plan').length === 1 && planVersions.length === 2)
  check('plan_version_two_is_newest', planVersions[1]?.submittedSpec?.includes('verify') === true)

  // --- Switch to Vibe: plan finalizes, context carries, work happens ------
  await controller.submit(`Create the file ${target} with contents ${tag}`, 'vibe')
  rounds = storeProbe.listRoundDetails(sessionId)
  const planAfter = rounds.find((round) => round.mode === 'plan')
  const vibeRound = rounds.find((round) => round.mode === 'vibe')
  check('mode_switch_finalizes_plan', planAfter?.status === 'completed')
  check('vibe_round_active', vibeRound?.status === 'active')
  check('vibe_turn_completed', (vibeRound?.vibeEntries ?? []).length === 1 && vibeRound?.vibeEntries[0]?.executionOutcome === 'completed')
  check('vibe_implemented_the_requirement', await fileExists(join(ws, target)))
  const dshAfterVibe = storeProbe.getSession(sessionId)?.dshSessionId
  check('same_dsh_session_across_modes', Boolean(dshAfterPlan) && dshAfterPlan === dshAfterVibe)

  // --- Leaving Plan is real: a further Vibe turn executes normally ---------
  const secondTarget = 'plan-second.txt'
  await controller.submit(`Create the file ${secondTarget} with contents ok`, 'vibe')
  check('second_vibe_turn_executes', await fileExists(join(ws, secondTarget)))
} finally {
  await controller.dispose().catch(() => {})
  await rm(tempRoot, { recursive: true, force: true }).catch(() => {})
}

const failed = Object.entries(checks).filter(([, ok]) => !ok)
console.log(JSON.stringify({ checks, passed: failed.length === 0, failed: failed.map(([name]) => name) }, null, 2))
process.exit(failed.length === 0 ? 0 : 1)
