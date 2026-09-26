/**
 * Phase-A/E acceptance: a discovered legacy DSH Session, resumed by the
 * installed app, keeps its original DSH id and context, and the first Codey
 * submission creates Round 1 on that same DSH Session. The app is then
 * restarted and the same product Session is recovered and continued.
 *
 *   TEMPORAL_TEST_API_KEY=... TEMPORAL_TEST_BASE_URL=... \
 *   TEMPORAL_TEST_PROVIDER=volc-ark TEMPORAL_TEST_MODEL=deepseek-v4-flash \
 *   node scripts/probes/installed-app-legacy-e2e.mjs
 *
 * Seeds one persisted DSH session with a random marker through the public ACP
 * surface, then drives the installed app over CDP. Prints only counts, ids
 * (lengths), booleans and statuses. Never prints the credential or model text.
 */
import { spawn, spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import { mkdtemp, mkdir, readdir, realpath } from 'node:fs/promises'
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
const baseUrl = process.env.TEMPORAL_TEST_BASE_URL
const credential = process.env.TEMPORAL_TEST_API_KEY ?? process.env.DEEPSEEK_API_KEY
const port = process.env.TEMPORAL_CDP_PORT ?? '9225'
const timeoutMs = Number(process.env.TEMPORAL_E2E_TIMEOUT_MS ?? 240000)
const appExe = process.env.TEMPORAL_APP_EXE
  ?? join(process.env.LOCALAPPDATA ?? '', 'Programs', 'Temporal Workspace', 'Temporal Workspace.exe')

const report = {
  provider,
  model,
  hasBaseUrl: Boolean(baseUrl),
  hasCredential: Boolean(credential),
  appExeExists: existsSync(appExe)
}

if (!credential || !report.appExeExists) {
  console.log(JSON.stringify({ ...report, status: 'skipped', reason: !credential ? 'credential absent' : 'installed app not found' }, null, 2))
  process.exit(2)
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const keepalive = setInterval(() => {}, 1000)

// --- isolated DSH home + workspace so the legacy session is deterministic ---
const root = await mkdtemp(join(tmpdir(), 'temporal-legacy-e2e-'))
const dshHome = join(root, 'dsh-home')
await mkdir(dshHome, { recursive: true })
const workspace = await realpath(await mkdir(join(root, 'workspace'), { recursive: true }).then(() => join(root, 'workspace')))
process.env.DSH_HOME = dshHome
const marker = `legacy-${randomUUID().slice(0, 8)}`
const settings = { provider, model, ...(baseUrl ? { baseUrl } : {}) }

// --- bundle the real runtime + discovery used for seeding and a pre-check ---
const runtimeBundle = join(here, '.cache-legacy-runtime.cjs')
await esbuild.build({
  entryPoints: [join(repoRoot, 'src/main/dsh/DshRuntime.ts')],
  bundle: true, platform: 'node', format: 'cjs', outfile: runtimeBundle,
  external: ['@agentclientprotocol/sdk'], logLevel: 'silent'
})
const discoveryBundle = join(here, '.cache-legacy-discovery.cjs')
await esbuild.build({
  entryPoints: [join(repoRoot, 'src/main/dsh/SessionDiscovery.ts')],
  bundle: true, platform: 'node', format: 'cjs', outfile: discoveryBundle,
  external: ['@agentclientprotocol/sdk'], logLevel: 'silent'
})
const { DshRuntime } = require(runtimeBundle)
const { SessionDiscovery } = require(discoveryBundle)

// 1) seed a persisted legacy session with a marker the new prompt never repeats.
let seededId
{
  const seeder = new DshRuntime({ workspacePath: workspace, settings, credential, onEvent: () => {} })
  try {
    seededId = (await seeder.start()).sessionId
    await seeder.prompt(`Remember this token for a later question: ${marker}. Reply with one short sentence.`)
  } finally {
    await seeder.close()
  }
}
report.seed = { idLength: seededId.length, markerLength: marker.length }

// 2) discovery must see the seeded session before the app is involved.
const discovered = await new SessionDiscovery({ listTimeoutMs: 60_000 }).listByWorkspace(workspace)
report.seedDiscoverable = discovered.some((session) => session.id === seededId)

// --- CDP helpers (the app must be launched with --remote-debugging-port) ---
async function resolveWs() {
  const store = join(repoRoot, 'node_modules', '.pnpm')
  const dir = (await readdir(store)).find((name) => /^ws@/.test(name))
  if (!dir) throw new Error('ws package not found in pnpm store')
  return require(join(store, dir, 'node_modules', 'ws'))
}
const WebSocket = await resolveWs()

function launchApp() {
  const child = spawn(appExe, [`--remote-debugging-port=${port}`], {
    env: { ...process.env, DSH_HOME: dshHome },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  child.stdout.on('data', () => {})
  child.stderr.on('data', () => {})
  return child
}

function stopApp(child) {
  if (!child || child.pid === undefined) return
  try { spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }) } catch { /* already gone */ }
}

async function waitForExit(child, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!child || child.exitCode !== null || child.signalCode !== null) return true
    await sleep(500)
  }
  return false
}

async function connect() {
  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
  const page = list.find((target) => target.type === 'page')
  if (!page) throw new Error('no renderer page on CDP port')
  const socket = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject) })
  let nextId = 0
  const pending = new Map()
  socket.on('message', (raw) => {
    const message = JSON.parse(raw.toString())
    if (message.id && pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id)
      pending.delete(message.id)
      if (message.error) reject(new Error(`CDP ${message.error.code}: ${message.error.message}`))
      else resolve(message.result)
    }
  })
  socket.on('close', () => { for (const { reject } of pending.values()) reject(new Error('CDP socket closed')); pending.clear() })
  socket.on('error', () => { for (const { reject } of pending.values()) reject(new Error('CDP socket error')); pending.clear() })
  const send = (method, params) => {
    const id = ++nextId
    return new Promise((resolve, reject) => { pending.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params })) })
  }
  await send('Runtime.enable', {})
  const evaluate = async (expression) => {
    const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true })
    if (result.exceptionDetails) {
      const text = result.exceptionDetails.exception?.description ?? result.exceptionDetails.text
      throw new Error(`renderer threw: ${String(text).replace(/\s+/g, ' ').slice(0, 220)}`)
    }
    return result.result.value
  }
  return { evaluate, send, close: () => socket.close() }
}

async function attach(deadlineMs) {
  const deadline = Date.now() + deadlineMs
  let lastError
  while (Date.now() < deadline) {
    try { return await connect() } catch (error) { lastError = error; await sleep(1000) }
  }
  throw lastError ?? new Error('app did not expose CDP')
}

/** Submit through the real IPC without awaiting, so runner state can be polled. */
async function submitAndSettle(cdp, spec, mode) {
  await cdp.evaluate(
    `(() => { window.__submitResult = window.temporal.submit(${JSON.stringify(spec)}, ${JSON.stringify(mode)})` +
      `.then(() => 'ok', (e) => 'ERR:' + (e && e.message)); return 'started' })()`
  )
  const startedAt = Date.now()
  let snapshot
  while (Date.now() - startedAt < timeoutMs) {
    snapshot = await cdp.evaluate('window.temporal.getSnapshot()')
    if (!snapshot.running) break
    await sleep(1500)
  }
  const submitResult = await cdp.evaluate('window.__submitResult')
  return { snapshot, submitResult, timedOut: Boolean(snapshot?.running) }
}

let appProcess
let cdp
try {
  // --- phase A: installed app discovers and resumes the legacy session ---
  appProcess = launchApp()
  cdp = await attach(60000)
  await cdp.evaluate('window.temporal.saveModelSettings(' + JSON.stringify({ provider, model, baseUrl, credential }) + ')')

  const listed = await cdp.evaluate(`window.temporal.listSessions(${JSON.stringify(workspace)})`)
  const legacy = listed.sessions.find((session) => session.dshSessionId === seededId)
  const opened = await cdp.evaluate(`window.temporal.openSession(${JSON.stringify(workspace)}, ${JSON.stringify(seededId)})`)
  report.phaseA = {
    listedCount: listed.sessions.length,
    legacyFound: Boolean(legacy),
    legacyKind: legacy?.kind ?? null,
    legacyHasTemporalHistory: legacy?.hasTemporalHistory ?? null,
    openedKind: opened.session?.kind ?? null,
    openedKeepsDshId: opened.session?.dshSessionId === seededId,
    openedHistoryState: opened.historyState,
    openedRounds: opened.rounds.length
  }

  const firstSpec = 'What token did I ask you to remember before? Reply with only that token.'
  const first = await submitAndSettle(cdp, firstSpec, 'vibe')
  await cdp.evaluate('window.temporal.endRound()')
  const productSessionId = opened.session.id
  const afterFirst = await cdp.evaluate(`window.temporal.openSession(${JSON.stringify(workspace)}, ${JSON.stringify(productSessionId)})`)
  const firstRound = afterFirst.rounds.at(-1)
  const firstText = firstRound?.bodyMarkdown ?? ''
  report.phaseA.round = {
    count: afterFirst.rounds.length,
    sequence: firstRound?.sequence ?? null,
    status: firstRound?.status ?? null,
    sameDshId: afterFirst.session?.dshSessionId === seededId,
    recalledMarker: firstText.includes(marker),
    specDidNotContainMarker: !firstSpec.includes(marker),
    submittedSpecMatches: firstRound?.vibeEntries?.[0]?.specMarkdown === firstSpec,
    submitResult: first.submitResult,
    timedOut: first.timedOut
  }

  // Close the window so the session lease is released through the normal quit
  // path; a forced kill would leave it held until the 15s TTL expires.
  cdp.send('Runtime.evaluate', { expression: 'window.close()' }).catch(() => {})
  await waitForExit(appProcess, 15000)
  cdp.close()
  cdp = undefined
  stopApp(appProcess)
  appProcess = undefined
  await sleep(1500)

  // --- phase B: restart, recover the product session, continue on the same DSH id ---
  appProcess = launchApp()
  cdp = await attach(60000)
  await cdp.evaluate('window.temporal.saveModelSettings(' + JSON.stringify({ provider, model, baseUrl, credential }) + ')')
  // If the graceful release did not happen, fall back to the lease TTL.
  let reopened
  const reopenDeadline = Date.now() + 40000
  while (Date.now() < reopenDeadline) {
    try { reopened = await cdp.evaluate(`window.temporal.openSession(${JSON.stringify(workspace)}, ${JSON.stringify(productSessionId)})`); break }
    catch (error) {
      if (!/already open in another window or process/i.test(String(error?.message ?? error))) throw error
      await sleep(3000)
    }
  }
  if (!reopened) throw new Error('session lease did not recover after restart')
  const secondSpec = 'After the restart, what token did I ask you to remember? Reply with only that token.'
  const second = await submitAndSettle(cdp, secondSpec, 'vibe')
  await cdp.evaluate('window.temporal.endRound()')
  const afterSecond = await cdp.evaluate(`window.temporal.openSession(${JSON.stringify(workspace)}, ${JSON.stringify(productSessionId)})`)
  const secondRound = afterSecond.rounds.at(-1)
  const secondText = secondRound?.bodyMarkdown ?? ''
  report.phaseB = {
    recoveredRounds: reopened.rounds.length,
    recoveredDshId: reopened.session?.dshSessionId === seededId,
    roundsAfterSubmit: afterSecond.rounds.length,
    recalledMarkerAfterRestart: secondText.includes(marker),
    sameDshIdAfterSubmit: afterSecond.session?.dshSessionId === seededId,
    submitResult: second.submitResult,
    timedOut: second.timedOut
  }

  report.passed = Boolean(
    report.seedDiscoverable &&
    report.phaseA.legacyFound &&
    report.phaseA.legacyKind === 'legacy' &&
    report.phaseA.legacyHasTemporalHistory === false &&
    report.phaseA.openedKeepsDshId &&
    report.phaseA.openedHistoryState === 'legacy-unavailable' &&
    report.phaseA.openedRounds === 0 &&
    report.phaseA.round.count === 1 &&
    report.phaseA.round.sequence === 1 &&
    report.phaseA.round.sameDshId &&
    report.phaseA.round.recalledMarker &&
    report.phaseA.round.specDidNotContainMarker &&
    report.phaseA.round.submittedSpecMatches &&
    report.phaseB.recoveredRounds === 1 &&
    report.phaseB.recoveredDshId &&
    report.phaseB.roundsAfterSubmit === 2 &&
    report.phaseB.recalledMarkerAfterRestart &&
    report.phaseB.sameDshIdAfterSubmit
  )
} catch (error) {
  report.status = 'failed'
  report.failure = String(error?.message ?? error).replace(/\s+/g, ' ').slice(0, 300)
} finally {
  if (cdp) cdp.close()
  stopApp(appProcess)
  clearInterval(keepalive)
}

console.log(JSON.stringify(report, null, 2))
process.exitCode = report.passed ? 0 : 1
