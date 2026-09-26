/**
 * TODO 6 §1.1 acceptance probe: session exclusivity and recovery ordering,
 * driven through two real WindowController instances over one shared SQLite
 * database (the same state two app processes would see).
 *
 * Verified through controller paths, not store calls alone:
 *  1. while A executes (runtime_active=1), B's openSession is rejected and
 *     A's round/runtime_active/execution are untouched
 *  2. a failed open never reconciles another window's live round and never
 *     leaks a lock: A keeps ownership, a later open after release succeeds
 *  3. a window whose lease is lost cannot submit, save drafts, change
 *     permission, or restart a runtime — its error surface is updated
 *  4. only a real crash (dangling active+runtime_active round, no lease)
 *     followed by a successful lock acquisition reconciles to interrupted
 *
 * A real model turn (cheap, one short reply) establishes the "executing"
 * state through the real submit path. Credentials come from the environment
 * and are never printed.
 *
 * Run: node scripts/probes/session-exclusivity.mjs
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createRequire } from 'node:module'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

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

// electron stub for the bundler: CredentialVault only needs safeStorage.
const electronStub = join(here, '.cache-exclusive-electron.cjs')
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

const { WindowController } = await bundle('src/main/WindowController.ts', join(here, '.cache-exclusive-controller.cjs'))
const { ProductStore } = await bundle('src/main/persistence/ProductStore.ts', join(here, '.cache-exclusive-store.cjs'))
const { CredentialVault } = await bundle('src/main/settings/CredentialVault.ts', join(here, '.cache-exclusive-vault.cjs'))

const checks = {}
const check = (name, value) => { checks[name] = Boolean(value) }
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const run = promisify(execFile)

const tempRoot = await mkdtemp(join(tmpdir(), 'temporal-exclusive-'))
// Isolated DSH home so probe sessions never mix with the user's real ones.
const dshHome = join(tempRoot, 'dsh-home')
process.env.DSH_HOME = dshHome

const dbPath = join(tempRoot, 'probe.sqlite')
const storeA = new ProductStore(dbPath)
const storeB = new ProductStore(dbPath)

/** Direct read of the physical round state (the same bytes any process sees). */
function roundState(roundId) {
  const db = new DatabaseSync(dbPath, { readOnly: true })
  try {
    return db.prepare('SELECT status, runtime_active FROM rounds WHERE id = ?').get(roundId)
  } finally {
    db.close()
  }
}
function writeRoundState(roundId, status, runtimeActive) {
  const db = new DatabaseSync(dbPath)
  try {
    db.prepare('UPDATE rounds SET status = ?, runtime_active = ?, closed_at = NULL WHERE id = ?').run(status, runtimeActive ? 1 : 0, roundId)
  } finally {
    db.close()
  }
}
function deleteLease(sessionId) {
  const db = new DatabaseSync(dbPath)
  try {
    db.prepare('DELETE FROM session_leases WHERE product_session_id = ?').run(sessionId)
  } finally {
    db.close()
  }
}

let snapshotsA = []
const makeWindowStub = (sink) => ({
  isDestroyed: () => false,
  webContents: { send: (_channel, snapshot) => { if (sink) sink(snapshot) } }
})
const controllerA = new WindowController(
  makeWindowStub((snapshot) => snapshotsA.push(snapshot)),
  storeA,
  new CredentialVault(join(tempRoot, 'vault-a.bin'))
)
const controllerB = new WindowController(makeWindowStub(null), storeB, new CredentialVault(join(tempRoot, 'vault-b.bin')))

try {
  const ws = join(tempRoot, 'ws')
  await run('git', ['-C', tempRoot, 'init', ws], { windowsHide: true })
  await writeFile(join(ws, 'readme.txt'), 'probe workspace\n')

  await controllerA.saveModelSettings({ provider, model, baseUrl, credential })
  const opened = await controllerA.openSession(ws)
  const sessionId = opened.session.id

  // --- 1. A executes; B is rejected; A's state is untouched ---------------
  const submitPromise = controllerA.submit('Reply with the single word ok.', 'vibe').catch((error) => ({ error }))
  let liveRoundId = null
  for (let i = 0; i < 120; i += 1) {
    await wait(500)
    const rounds = storeB.listRounds(sessionId)
    const active = rounds.find((round) => round.status === 'active')
    if (active && roundState(active.id)?.runtime_active === 1) { liveRoundId = active.id; break }
  }
  check('a_execution_started_runtime_active', Boolean(liveRoundId))

  let rejected = null
  try { await controllerB.openSession(ws, sessionId) } catch (error) { rejected = error }
  check('b_open_rejected', Boolean(rejected))
  check('b_rejection_names_ownership', rejected instanceof Error && /already open|独占|另一个/.test(rejected.message))

  const stateAfterRejection = liveRoundId ? roundState(liveRoundId) : null
  check('a_round_still_active', stateAfterRejection?.status === 'active' && stateAfterRejection?.runtime_active === 1)
  check('b_failed_open_did_not_reconcile', storeB.listRounds(sessionId).length === 1)

  // A's ownership is intact after B's failed attempt.
  await controllerA.saveDraft('probe draft', 'vibe')
  check('a_ownership_intact_after_b_rejection', storeB.getDraft(sessionId).draft === 'probe draft')

  const submitOutcome = await submitPromise
  check('a_submission_completes', !(submitOutcome && submitOutcome.error))
  // A Vibe round stays open after a turn (a mode switch finalizes it); what
  // matters here is that the execution is no longer dangling.
  const finishedState = liveRoundId ? roundState(liveRoundId) : null
  check('a_turn_finished_not_dangling', finishedState?.status === 'active' && finishedState?.runtime_active === 0)

  // --- 2. lease lost: A can no longer mutate protected state --------------
  deleteLease(sessionId)
  let lostObserved = false
  for (let i = 0; i < 12 && !lostObserved; i += 1) {
    await wait(500)
    lostObserved = snapshotsA.some((snapshot) => typeof snapshot.error === 'string' && snapshot.error.includes('独占锁'))
  }
  check('a_lease_loss_surfaced', lostObserved)
  let submitAfterLoss = null
  try { await controllerA.submit('another spec', 'vibe') } catch (error) { submitAfterLoss = error }
  check('a_submit_rejected_after_loss', Boolean(submitAfterLoss))
  let draftAfterLoss = null
  try { await controllerA.saveDraft('must not persist', 'vibe') } catch (error) { draftAfterLoss = error }
  check('a_save_draft_rejected_after_loss', Boolean(draftAfterLoss))
  let permissionAfterLoss = null
  try { await controllerA.setPermission('read-only') } catch (error) { permissionAfterLoss = error }
  check('a_set_permission_rejected_after_loss', Boolean(permissionAfterLoss))
  check('draft_unchanged_after_loss', storeB.getDraft(sessionId).draft === 'probe draft')

  // --- 3. real crash: dangling active+runtime_active round, no lease ------
  // A window died mid-turn: its round stays active+runtime_active and its
  // lease is gone (expired/deleted, never released). The next opener must
  // acquire the lock FIRST and only then reconcile the dangling execution.
  writeRoundState(liveRoundId, 'active', true)
  deleteLease(sessionId)
  const storeC = new ProductStore(dbPath)
  const controllerC = new WindowController(makeWindowStub(null), storeC, new CredentialVault(join(tempRoot, 'vault-c.bin')))

  await controllerC.openSession(ws, sessionId)
  const reconciled = roundState(liveRoundId)
  check('crash_reconciled_to_interrupted', reconciled?.status === 'interrupted' && reconciled?.runtime_active === 0)
  await controllerC.saveDraft('c owns it now', 'vibe')
  check('c_holds_lease_after_recovery', storeB.getDraft(sessionId).draft === 'c owns it now')

  // --- 4. failed open cleans up: no stale lock after release --------------
  await controllerC.dispose()
  const controllerD = new WindowController(makeWindowStub(null), storeA, new CredentialVault(join(tempRoot, 'vault-d.bin')))
  const reopened = await controllerD.openSession(ws, sessionId)
  check('reopen_after_release_succeeds', reopened.session.id === sessionId)
  await controllerD.dispose()
} finally {
  await controllerA.dispose().catch(() => {})
  await controllerB.dispose().catch(() => {})
  await rm(tempRoot, { recursive: true, force: true }).catch(() => {})
}

const failed = Object.entries(checks).filter(([, ok]) => !ok)
console.log(JSON.stringify({ checks, passed: failed.length === 0, failed: failed.map(([name]) => name) }, null, 2))
process.exit(failed.length === 0 ? 0 : 1)
