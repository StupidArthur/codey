/**
 * Phase-C UI acceptance: drive the installed app in a visible Windows desktop
 * session over CDP, capture screenshots at each state, and assert the DOM
 * matches the two HTML prototypes. UI states only; the real-model end-to-end
 * gates live in installed-app-e2e.mjs / installed-app-legacy-e2e.mjs.
 *
 *   TEMPORAL_TEST_API_KEY=... TEMPORAL_TEST_BASE_URL=... \
 *   TEMPORAL_TEST_PROVIDER=volc-ark TEMPORAL_TEST_MODEL=deepseek-v4-flash \
 *   node scripts/probes/installed-app-ui.mjs
 *
 * Screenshots are written to docs/evidence/ui/. Prints only booleans, counts
 * and labels. Never prints the credential or model text.
 */
import { spawn, spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import { mkdtemp, mkdir, readdir, stat, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, '..', '..')
const require = createRequire(import.meta.url)
const shotDir = join(repoRoot, 'docs', 'evidence', 'ui')

const provider = process.env.TEMPORAL_TEST_PROVIDER ?? 'volc-ark'
const model = process.env.TEMPORAL_TEST_MODEL ?? 'deepseek-v4-flash'
const baseUrl = process.env.TEMPORAL_TEST_BASE_URL ?? 'https://ark.cn-beijing.volces.com/api/plan/v3'
const credential = provider === 'deepseek-official'
  ? process.env.DEEPSEEK_API_KEY
  : (process.env.TEMPORAL_TEST_API_KEY ?? process.env.DEEPSEEK_API_KEY ?? process.env.VOLC_ARK_API_KEY)
const port = process.env.TEMPORAL_CDP_PORT ?? '9226'
const appExe = process.env.TEMPORAL_APP_EXE ?? join(process.env.LOCALAPPDATA ?? '', 'Programs', 'Temporal Workspace', 'Temporal Workspace.exe')

const report = { provider, model, hasBaseUrl: Boolean(baseUrl), hasCredential: Boolean(credential), appExeExists: existsSync(appExe), screenshots: [] }
if (!report.appExeExists) {
  console.log(JSON.stringify({ ...report, status: 'skipped', reason: 'installed app not found' }, null, 2))
  process.exit(2)
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const keepalive = setInterval(() => {}, 1000)

async function resolveWs() {
  const store = join(repoRoot, 'node_modules', '.pnpm')
  const dir = (await readdir(store)).find((name) => /^ws@/.test(name))
  if (!dir) throw new Error('ws package not found in pnpm store')
  return require(join(store, dir, 'node_modules', 'ws'))
}
const WebSocket = await resolveWs()

const workspace = await mkdtemp(join(tmpdir(), 'temporal-ui-'))
const dshHome = join(workspace, '..', `ui-dsh-home-${Date.now()}`)
await mkdir(dshHome, { recursive: true })

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
  try { spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }) } catch { /* gone */ }
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
      clearTimeout(pending.get(message.id).timer)
      pending.delete(message.id)
      if (message.error) reject(new Error(`CDP ${message.error.code}: ${message.error.message}`))
      else resolve(message.result)
    }
  })
  socket.on('close', () => { for (const { reject, timer } of pending.values()) { clearTimeout(timer); reject(new Error('CDP socket closed')) }; pending.clear() })
  socket.on('error', () => { for (const { reject, timer } of pending.values()) { clearTimeout(timer); reject(new Error('CDP socket error')) }; pending.clear() })
  const send = (method, params) => {
    const id = ++nextId
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP ${method} timed out`)) }, 35000)
      pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params }))
    })
  }
  await send('Runtime.enable', {})
  await send('Page.enable', {})
  const evaluate = async (expression) => {
    const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true })
    if (result.exceptionDetails) {
      const text = result.exceptionDetails.exception?.description ?? result.exceptionDetails.text
      throw new Error(`renderer threw: ${String(text).replace(/\s+/g, ' ').slice(0, 200)}`)
    }
    return result.result.value
  }
  return { send, evaluate, close: () => socket.close() }
}

async function attach(deadlineMs) {
  const deadline = Date.now() + deadlineMs
  let lastError
  while (Date.now() < deadline) {
    try { return await connect() } catch (error) { lastError = error; await sleep(1000) }
  }
  throw lastError ?? new Error('app did not expose CDP')
}

let appProcess
let cdp
const checks = {}
try {
  appProcess = launchApp()
  cdp = await attach(60000)
  const { send, evaluate } = cdp

  // Real OS window on the visible desktop (not a headless webview).
  const windowInfo = spawnSync('powershell', ['-NoProfile', '-Command',
    "$p = Get-Process -Name 'Temporal Workspace' -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1; if ($p) { $p.MainWindowTitle + '/' + $p.MainWindowHandle } else { 'none' }"],
    { encoding: 'utf8' })
  report.osWindow = (windowInfo.stdout || '').trim()

  const shot = async (name) => {
    const result = await send('Page.captureScreenshot', { format: 'png' })
    const file = join(shotDir, `${name}.png`)
    await writeFile(file, Buffer.from(result.data, 'base64'))
    report.screenshots.push(name)
  }
  const desktopShot = (name) => {
    const file = join(shotDir, `${name}.png`)
    spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(here, 'capture-window.ps1'), '-Out', file, '-Mode', '2'], { stdio: 'ignore' })
    report.screenshots.push(name)
  }
  const waitFor = async (expression, timeoutMs, intervalMs = 500) => {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (await evaluate(expression)) return true
      await sleep(intervalMs)
    }
    return false
  }
  const clickText = (selector, text) => evaluate(
    `(() => { const el = [...document.querySelectorAll(${JSON.stringify(selector)})].find(b => b.textContent.trim() === ${JSON.stringify(text)}); if (!el) return false; el.click(); return true })()`
  )
  const clickSelector = (selector) => evaluate(
    `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false; el.click(); return true })()`
  )
  const setDraft = (spec, mode) => evaluate(`window.temporal.saveDraft(${JSON.stringify(spec)}, ${JSON.stringify(mode)})`)
  const snapshot = () => evaluate('window.temporal.getSnapshot()')
  const waitRunning = async (want, timeoutMs) => {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (Boolean((await snapshot()).running) === want) return true
      await sleep(800)
    }
    return false
  }
  const waitIdle = () => waitRunning(false, 240000)

  await mkdir(shotDir, { recursive: true })

  // --- 1. startup launcher (no workspace) ---
  report.launcherHero = await evaluate('document.body.innerText.includes("打开一个 Workspace")')
  await shot('01-startup-launcher')
  desktopShot('01-startup-launcher-desktop')

  // --- 2. workspace picker with session list (only if the API is overridable) ---
  const overridable = await evaluate(`(() => { const original = window.temporal.chooseWorkspace; try { window.temporal.chooseWorkspace = async () => ${JSON.stringify(workspace)} } catch {} ; return window.temporal.chooseWorkspace !== original })()`)
  report.pickerOverrideSupported = overridable
  if (overridable) {
    await clickText('button', '选择目录')
    await sleep(1500)
    report.pickerShowsNewSession = await evaluate('document.body.innerText.includes("New Session")')
    await shot('02-startup-sessions')
  }

  // --- 3. enter a new session ---
  await evaluate(`window.temporal.openSession(${JSON.stringify(workspace)})`)
  await waitFor('!!document.querySelector(".workspace")', 15000)
  if (credential) await evaluate('window.temporal.saveModelSettings(' + JSON.stringify({ provider, model, baseUrl, credential }) + ')')
  report.workspaceChrome = {
    hasModeSwitch: await evaluate('!!document.querySelector(".spec-toolbar .segmented")'),
    hasEditor: await evaluate('!!document.querySelector(".code-editor, .spec-body")'),
    hasTimeline: await evaluate('!!document.querySelector(".timeline")'),
    modeLabels: await evaluate('(() => { const g = document.querySelector(".spec-toolbar .segmented"); return g ? [...g.querySelectorAll("button")].map(b => b.textContent.trim()) : [] })()'),
    permission: (await evaluate('window.temporal.getSnapshot()')).permission
  }
  await shot('03-workspace-empty')

  // The persisted draft carries the mode, so the mode switch and the editor
  // stay in sync without typing into CodeMirror; submit uses the real button.
  const runTurn = async (spec, mode) => {
    await setDraft(spec, mode)
    await sleep(900)
    const clicked = await clickSelector('.spec-footer .primary-button')
    if (!clicked) throw new Error(`submit button missing for ${mode}`)
    const started = await waitRunning(true, 30000)
    const idle = await waitIdle()
    return { started, idle, error: (await snapshot()).error ?? null }
  }

  // --- 4. Plan, twice: one Round, two versions ---
  report.plan = {
    plan1: await runTurn('Plan how to create a short RELEASE.md explaining the release. Do not implement it yet.', 'plan'),
    plan2: await runTurn('Revise the plan to include a rollback step.', 'plan')
  }
  report.plan.timelineCount = await evaluate('document.querySelectorAll(".timeline-item").length')
  report.plan.versionTabs = await evaluate('document.querySelectorAll(".version-tabs button").length')
  report.plan.firstRoundLabel = await evaluate('document.querySelector(".timeline-item")?.innerText ?? ""')
  report.plan.dshId = (await snapshot()).session.dshSessionId
  report.plan.noImplementation = !(await stat(join(workspace, 'RELEASE.md')).then(() => true).catch(() => false))
  await shot('04-plan-versions')
  // Note: only the launcher state gets a window-level PrintWindow capture; every
  // workspace state is captured through CDP, which returns exactly the renderer
  // pixels shown in the window and never pixels from another window.

  // --- 5. Vibe run: capture the Runner open, collapse, sidebar collapse, restore ---
  await setDraft('Create RELEASE.md describing this release in one short sentence.', 'vibe')
  await sleep(900)
  await clickSelector('.spec-footer .primary-button')
  report.runner = { openSeen: await waitFor('!!document.querySelector(".runner-panel")', 20000, 300) }
  await shot('05-runner-open')
  report.runner.collapseClicked = await evaluate('(() => { const el = [...document.querySelectorAll(".runner-header button")].find(b => b.textContent.includes("收起")); if (!el) return false; el.click(); return true })()')
  await sleep(500)
  report.runner.miniShown = await evaluate('!!document.querySelector(".runner-mini")')
  await shot('06-runner-collapsed')
  report.runner.sidebarCollapsed = await clickSelector('.sidebar-header .icon-button')
  await sleep(500)
  report.runner.collapsedClass = await evaluate('!!document.querySelector(".workspace.sidebar-collapsed")')
  report.runner.miniAccessibleWhenCollapsed = await evaluate('!!document.querySelector(".sidebar .runner-mini")')
  await shot('07-sidebar-collapsed')
  report.runner.restoreClicked = await evaluate('(() => { const el = document.querySelector(".runner-mini"); if (!el) return false; el.click(); return true })()')
  await sleep(500)
  report.runner.restored = await evaluate('!!document.querySelector(".runner-panel")')
  await shot('08-runner-restored')
  await clickSelector('.sidebar-header .icon-button') // expand sidebar again
  report.runner.idle = await waitIdle()
  report.vibeSecond = await runTurn('Create ROLLBACK.md describing how to roll back this release in one short sentence. Keep RELEASE.md.', 'vibe')

  // --- 6. end the Vibe Round so its top-level Result renders ---
  report.vibe = { endRoundClicked: await clickSelector('.spec-footer .secondary-button') }
  await waitFor('!!document.querySelector(".result-block")', 12000, 300)
  report.vibe.resultRendered = await evaluate('!!document.querySelector(".result-block")')
  report.vibe.timelineCount = await evaluate('document.querySelectorAll(".timeline-item").length')
  const vibeSnapshot = await snapshot()
  const vibeRound = vibeSnapshot.rounds.find(r => r.mode === 'vibe')
  report.vibe.twoEntries = vibeRound?.vibeEntries.length === 2
  report.vibe.wholeSummary = vibeRound?.result?.summary.includes('请求#1') && vibeRound?.result?.summary.includes('请求#2')
  report.vibe.unverifiedExplicit = vibeRound?.result?.verification.some(line => line.includes('本轮未运行验证'))
  report.vibe.sameDshSession = vibeSnapshot.session.dshSessionId === report.plan.dshId
  report.vibe.filesExist = await stat(join(workspace, 'RELEASE.md')).then(() => true).catch(() => false)
    && await stat(join(workspace, 'ROLLBACK.md')).then(() => true).catch(() => false)
  const savedVibeResult = JSON.stringify(vibeRound.result)
  const productSessionId = vibeSnapshot.session.id
  delete report.plan.dshId
  await shot('09-vibe-result')

  // --- 7. Loop A: a real, verifiable task must COMPLETE through the product's
  // verification executor. A Round ending is not the success criterion: the
  // workspace artifact must exist on disk and the Result must show the real
  // content-match evidence from the built-in (read-only) check. ---
  report.loopA = {}
  // Use a punctuation-free random marker (same pattern as installed-app-e2e):
  // a spec line ending in "ok." would be written back literally as "ok." by
  // the model while the extracted expected value is "ok", so the content check
  // could never pass and the loop would churn on rewrites until the budget.
  await mkdir(join(workspace, 'tests'), { recursive: true })
  await writeFile(join(workspace, 'package.json'), JSON.stringify({ name: 'closure-calc', scripts: { test: 'node tests/run.cjs' } }))
  await writeFile(join(workspace, 'calc.cjs'), 'exports.add = (a, b) => a - b\n')
  const originalTests = "const assert = require('node:assert'); const {add} = require('../calc.cjs'); assert.equal(add(2,3),5); assert.equal(add(-1,1),0); console.log('checks passed')\n"
  await writeFile(join(workspace, 'tests/run.cjs'), originalTests)
  report.loopA.run = await runTurn('Fix the addition bug in calc.cjs so add adds its arguments correctly. Keep the existing tests unchanged and ensure tests pass.', 'loop')
  report.loopA.artifactOnDisk = (await readFile(join(workspace, 'calc.cjs'), 'utf8')).includes('+')
  report.loopA.testsUnchanged = (await readFile(join(workspace, 'tests/run.cjs'), 'utf8')) === originalTests
  const artifacts = await readdir(join(workspace, 'temporal-verify')).catch(() => [])
  report.loopA.actualCheckArtifacts = false
  for (const name of artifacts.filter(name => /^tests-[0-9a-f]+\.exit$/.test(name))) {
    const exit = await readFile(join(workspace, 'temporal-verify', name), 'utf8')
    const log = await readFile(join(workspace, 'temporal-verify', name.replace(/\.exit$/, '.log')), 'utf8').catch(() => '')
    if (exit.trim() === '0' && log.includes('checks passed')) report.loopA.actualCheckArtifacts = true
  }
  report.loopA.diskTestsPass = spawnSync(process.execPath, [join(workspace, 'tests/run.cjs')], { windowsHide: true, stdio: 'ignore', timeout: 15000 }).status === 0
  report.loopA.loopTerminalClass = await evaluate('document.querySelector(".loop-terminal")?.className ?? ""')
  report.loopA.terminalText = await evaluate('document.querySelector(".loop-terminal")?.innerText ?? ""')
  report.loopA.verificationLines = await evaluate(`(() => { const section = [...document.querySelectorAll(".result-block .result-section")].find(s => s.querySelector("h3")?.textContent === "Verification"); return section ? [...section.querySelectorAll("li")].map(li => li.textContent) : [] })()`)
  report.loopA.remainingLines = await evaluate('[...document.querySelectorAll(".result-block .result-section.remaining li")].map(li => li.textContent)')
  report.loopA.completed = report.loopA.loopTerminalClass.includes('loop-completed')
  report.loopA.hasSandboxVerification = report.loopA.verificationLines.some((line) => line.includes('DSH 沙盒检查报告；产品核实结果产物及输入快照'))
  report.loopA.allResultSections = await evaluate('[...document.querySelectorAll(".result-block .result-section h3")].map(el => el.textContent)')
  report.loopA.timelineCount = await evaluate('document.querySelectorAll(".timeline-item").length')
  await shot('10-loop-a-result')

  // --- 8. Loop B: a Round that ends without completing the task must NOT be
  // reported as success; the Result must state the honest failure. ---
  report.loopB = {}
  report.loopB.run = await runTurn('The file sealed.md must exist. It is owned by an external process that is unavailable. Do not create, write or touch sealed.md yourself. If it is missing, report blocked and ask for the external file.', 'loop')
  report.loopB.loopTerminalClass = await evaluate('document.querySelector(".loop-terminal")?.className ?? ""')
  report.loopB.terminalText = await evaluate('document.querySelector(".loop-terminal")?.innerText ?? ""')
  report.loopB.remainingLines = await evaluate('[...document.querySelectorAll(".result-block .result-section.remaining li")].map(li => li.textContent)')
  report.loopB.notReportedCompleted = !report.loopB.loopTerminalClass.includes('loop-completed')
  report.loopB.timelineCount = await evaluate('document.querySelectorAll(".timeline-item").length')
  await shot('11-loop-b-honest-failure')

  // --- 9. round switching ---
  report.roundSwitch = { clickedFirst: await evaluate('(() => { const el = document.querySelectorAll(".timeline-item")[0]; if (!el) return false; el.click(); return true })()') }
  await sleep(500)
  await shot('11-round-1')
  report.roundSwitch.firstSelected = await evaluate('document.querySelector(".timeline-item")?.classList.contains("selected")')
  report.roundSwitch.clickedLast = await evaluate('(() => { const els = document.querySelectorAll(".timeline-item"); const el = els[els.length - 1]; if (!el) return false; el.click(); return true })()')
  await sleep(500)
  await shot('12-round-last')

  report.passed = Boolean(
    report.launcherHero &&
    report.workspaceChrome.hasModeSwitch && report.workspaceChrome.hasEditor && report.workspaceChrome.hasTimeline &&
    report.workspaceChrome.modeLabels.join(',') === 'Plan,Vibe,Loop' &&
    report.plan.timelineCount === 1 && report.plan.versionTabs >= 2 &&
    report.runner.openSeen && report.runner.miniShown && report.runner.collapsedClass &&
    report.runner.miniAccessibleWhenCollapsed && report.runner.restored &&
    report.plan.noImplementation && report.vibe.resultRendered && report.vibe.twoEntries && report.vibe.wholeSummary &&
    report.vibe.unverifiedExplicit && report.vibe.sameDshSession && report.vibe.filesExist &&
    report.loopA.completed && report.loopA.artifactOnDisk && report.loopA.testsUnchanged && report.loopA.hasSandboxVerification &&
    report.loopA.actualCheckArtifacts && report.loopA.diskTestsPass &&
    report.loopB.notReportedCompleted &&
    report.roundSwitch.firstSelected
  )
  // Re-open the installed application, not merely the renderer, and verify the
  // already persisted four-part Vibe Result is identical.
  send('Runtime.evaluate', { expression: 'window.close()' }).catch(() => {})
  await new Promise(resolve => { appProcess.once('exit', resolve); setTimeout(resolve, 15000) })
  cdp.close()
  stopApp(appProcess)
  await sleep(1500)
  appProcess = launchApp()
  cdp = undefined
  const restartDeadline = Date.now() + 60000
  while (Date.now() < restartDeadline && !cdp) { try { cdp = await connect() } catch { await sleep(1000) } }
  if (!cdp) throw new Error('could not attach after installed-app restart')
  const reopened = await cdp.evaluate(`window.temporal.openSession(${JSON.stringify(workspace)}, ${JSON.stringify(productSessionId)})`)
  report.vibe.resultSurvivesRestart = JSON.stringify(reopened.rounds.find(r => r.mode === 'vibe')?.result) === savedVibeResult
  report.passed = report.passed && report.vibe.resultSurvivesRestart
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
