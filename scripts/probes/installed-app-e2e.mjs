/**
 * Installed-app end-to-end acceptance for the packaged Temporal Workspace.
 *
 * Drives the running packaged app's renderer over CDP (the app must be started
 * with `--remote-debugging-port=9222`) and exercises the real product IPC:
 * configure the model in-product → open a fresh workspace session → submit a
 * real turn against the configured model → wait for it to settle → read the
 * persisted projection and the deterministic Result document.
 *
 * Two scenarios run in sequence:
 *   - vibe: a single turn that must create a workspace file, then ended
 *     explicitly so the Vibe Result is persisted;
 *   - loop: an evidence-gated loop that may only complete once a verification
 *     runner event passed.
 *
 *   TEMPORAL_TEST_API_KEY=... TEMPORAL_TEST_BASE_URL=... \
 *   TEMPORAL_TEST_PROVIDER=volc-ark TEMPORAL_TEST_MODEL=deepseek-v4-flash \
 *   node scripts/probes/installed-app-e2e.mjs
 *
 * Prints only counts, kinds, statuses, booleans and the workspace file check.
 * Never prints the credential, prompts, or model output text.
 */
import { createRequire } from 'node:module'
import { mkdtemp, readFile, readdir, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, '..', '..')
const require = createRequire(import.meta.url)

// `ws` is a transitive dependency under pnpm's isolated store, not a root dep.
async function resolveWs() {
  const store = join(repoRoot, 'node_modules', '.pnpm')
  const dir = (await readdir(store)).find((name) => /^ws@/.test(name))
  if (!dir) throw new Error('ws package not found in pnpm store')
  return require(join(store, dir, 'node_modules', 'ws'))
}
const WebSocket = await resolveWs()

const CDP_PORT = process.env.TEMPORAL_CDP_PORT ?? '9222'
const provider = process.env.TEMPORAL_TEST_PROVIDER ?? 'volc-ark'
const model = process.env.TEMPORAL_TEST_MODEL ?? 'deepseek-v4-flash'
const baseUrl = process.env.TEMPORAL_TEST_BASE_URL ?? 'https://ark.cn-beijing.volces.com/api/plan/v3'
const credential = process.env.TEMPORAL_TEST_API_KEY
const timeoutMs = Number(process.env.TEMPORAL_E2E_TIMEOUT_MS ?? 240000)
const scenarioFilter = process.env.TEMPORAL_TEST_SCENARIO ?? 'all'

const report = {
  cdpPort: CDP_PORT,
  provider,
  model,
  hasBaseUrl: Boolean(baseUrl),
  hasCredential: Boolean(credential),
  scenarios: {}
}

if (!credential) {
  console.log(JSON.stringify({ ...report, status: 'skipped', reason: 'TEMPORAL_TEST_API_KEY absent' }, null, 2))
  process.exit(2)
}

const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json()
const page = list.find((t) => t.type === 'page')
if (!page) {
  console.log(JSON.stringify({ ...report, status: 'failed', reason: 'no renderer page on CDP port' }, null, 2))
  process.exit(1)
}
report.pageUrlIsPackaged = page.url.includes('resources/app/out/renderer/index.html')

const socket = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((resolve, reject) => {
  socket.once('open', resolve)
  socket.once('error', reject)
})

let nextId = 0
const pending = new Map()
socket.on('message', (raw) => {
  const msg = JSON.parse(raw.toString())
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id)
    pending.delete(msg.id)
    if (msg.error) reject(new Error(`CDP ${msg.error.code}: ${msg.error.message}`))
    else resolve(msg.result)
  }
})
socket.on('close', () => {
  for (const { reject } of pending.values()) reject(new Error('CDP socket closed'))
  pending.clear()
})
socket.on('error', () => {
  for (const { reject } of pending.values()) reject(new Error('CDP socket error'))
  pending.clear()
})

function send(method, params) {
  const id = ++nextId
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    socket.send(JSON.stringify({ id, method, params }))
  })
}

await send('Runtime.enable', {})

async function evaluate(expression) {
  const result = await send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true
  })
  if (result.exceptionDetails) {
    const text = result.exceptionDetails.exception?.description ?? result.exceptionDetails.text
    throw new Error(`renderer threw: ${String(text).replace(/\s+/g, ' ').slice(0, 220)}`)
  }
  return result.result.value
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
// Keep the event loop alive so a slow CDP reply is never reported as an
// unsettled top-level await.
const keepalive = setInterval(() => {}, 1000)

function marker(prefix) {
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}`
}

/** Runs one submit through the real IPC and returns observed facts. */
async function runScenario(mode, buildSpec, { finalize }) {
  const workspace = await mkdtemp(join(tmpdir(), `temporal-app-${mode}-`))
  const tag = marker(`ARK-${mode.toUpperCase()}`)
  const spec = buildSpec(tag)

  const opened = await evaluate(`window.temporal.openSession(${JSON.stringify(workspace)})`)
  await evaluate(`window.temporal.setPermission('workspace-write')`)

  // Fire the submit without awaiting it so live runner events can be observed.
  await evaluate(
    `(() => { window.__submitResult = window.temporal.submit(${JSON.stringify(spec)}, ${JSON.stringify(mode)})` +
      `.then(() => 'ok', (e) => 'ERR:' + (e && e.message)); return 'started' })()`
  )

  const seenKinds = new Set()
  const startedAt = Date.now()
  let snapshot
  while (Date.now() - startedAt < timeoutMs) {
    snapshot = await evaluate('window.temporal.getSnapshot()')
    for (const event of snapshot.runnerEvents) seenKinds.add(event.kind)
    if (!snapshot.running) break
    await sleep(1500)
  }
  const submitResult = await evaluate('window.__submitResult')

  if (finalize) await evaluate('window.temporal.endRound()')
  const detail = await evaluate(
    `window.temporal.openSession(${JSON.stringify(workspace)}, ${JSON.stringify(snapshot.session.id)})`
  )
  const round = detail.rounds.at(-1)

  const notesPath = join(workspace, 'NOTES.md')
  let workspaceFile
  try {
    await stat(notesPath)
    workspaceFile = { exists: true, matchesMarker: (await readFile(notesPath, 'utf8')).trim() === tag }
  } catch {
    workspaceFile = { exists: false, matchesMarker: false }
  }

  return {
    workspaceChars: workspace.length,
    sessionKind: opened.session?.kind,
    sawRunning: seenKinds.size > 0,
    elapsedMs: Date.now() - startedAt,
    timedOut: Boolean(snapshot?.running),
    submitResult,
    runnerEventKinds: [...seenKinds].sort(),
    errorFromSnapshot: Boolean(snapshot?.error),
    historyState: detail.historyState,
    round: round
      ? {
          mode: round.mode,
          status: round.status,
          entries: round.vibeEntries.length,
          entryOutcomes: round.vibeEntries.map((e) => e.executionOutcome),
          evidence: round.evidence.length,
          evidenceKinds: [...new Set(round.evidence.map((e) => e.kind))].sort(),
          evidenceProvenance: [...new Set(round.evidence.map((e) => e.provenance))].sort(),
          notesEvidence: round.evidence.some((e) => e.kind === 'workspace' && e.label.includes('NOTES.md')),
          result: round.result
            ? {
                verificationCount: round.result.verification.length,
                changes: round.result.changes,
                remainingCount: round.result.remaining.length,
                loopTerminal: round.result.loopTerminal ?? null
              }
            : null
        }
      : null,
    workspaceFile
  }
}

const scenarios = {
  vibe: () => runScenario('vibe', (tag) => [
    'Create a file named NOTES.md in the current workspace.',
    `Its entire contents must be exactly the single line: ${tag}`,
    'After writing it, run a shell command that prints the file contents so the write is verified.'
  ].join(' '), { finalize: true }),

  loop: () => runScenario('loop', (tag) => [
    'Complete this task fully and verify it before finishing.',
    `Step 1: create a file named NOTES.md in the current workspace whose entire contents are exactly the single line: ${tag}`,
    'Step 2: verify the write by running this exact shell command: cmd /c echo test-verify && type NOTES.md',
    'If that verification succeeds, reply with exactly: done'
  ].join(' '), { finalize: false })
}

const passedChecks = []

try {
  const savedSettings = await evaluate(
    `window.temporal.saveModelSettings(${JSON.stringify({ provider, model, baseUrl, credential })})`
  )
  report.settingsSaved = {
    provider: savedSettings.provider,
    model: savedSettings.model,
    hasBaseUrl: Boolean(savedSettings.baseUrl),
    hasCredential: savedSettings.hasCredential
  }
  passedChecks.push(Boolean(savedSettings.hasCredential))

  for (const [name, run] of Object.entries(scenarios)) {
    if (scenarioFilter !== 'all' && scenarioFilter !== name) continue
    const result = await run()
    report.scenarios[name] = result
    if (name === 'vibe') {
      passedChecks.push(Boolean(
        result.round &&
        result.round.status === 'completed' &&
        result.round.evidence >= 1 &&
        result.round.notesEvidence &&
        result.round.result &&
        result.round.result.changes.some((change) => change.startsWith('NOTES.md')) &&
        result.workspaceFile.exists && result.workspaceFile.matchesMarker
      ))
    } else {
      passedChecks.push(Boolean(
        result.round &&
        ['completed', 'blocked', 'budget_exhausted', 'failed'].includes(result.round.status) &&
        result.round.evidence >= 1 &&
        result.round.result &&
        result.round.result.loopTerminal &&
        result.workspaceFile.exists && result.workspaceFile.matchesMarker
      ))
    }
  }
} catch (error) {
  report.status = 'failed'
  report.failure = String(error?.message ?? error).replace(/\s+/g, ' ').slice(0, 300)
} finally {
  clearInterval(keepalive)
  socket.close()
}

report.passed = passedChecks.length > 0 && passedChecks.every(Boolean)
console.log(JSON.stringify(report, null, 2))
process.exitCode = report.passed ? 0 : 1
