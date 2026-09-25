/**
 * P0 SDK contract probe. Run with:
 *   node scripts/probes/dsh-runtime-p0.mjs
 *   DEEPSEEK_API_KEY=... node scripts/probes/dsh-runtime-p0.mjs
 *
 * A credential enables prompt, sequential prompt and cross-process resume.
 * The script prints only phase status, session id, event counts and sanitized
 * assertions â€?never content, tokens or keys.
 *
 * Exit codes: 0 = all phases passed; 1 = a phase failed; 2 = skipped (no credential).
 */
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { DeepSeekHarness } from '@deepseek-ai/dsh-sdk-client'

const probeRoot = await mkdtemp(join(tmpdir(), 'temporal-dsh-p0-'))
const workspacePath = process.env.P0_WORKSPACE_PATH ?? probeRoot
const dshHome = process.env.P0_DSH_HOME ?? join(probeRoot, 'dsh-home')
const provider = process.env.P0_PROVIDER ?? 'deepseek-official'
const model = process.env.P0_MODEL ?? 'deepseek-v4-flash'
const hasCredential = Boolean(process.env.DEEPSEEK_API_KEY)
const phases = []
let sessionId
const memoryToken = `p0-${randomUUID().slice(0, 8)}`

function makeHarness() {
  return new DeepSeekHarness({
    profile: 'sdk', cwd: workspacePath, processCwd: workspacePath,
    dshHome, provider, model,
    initializeTimeoutMs: 60_000
  })
}

function summarize(notifications, events) {
  return {
    methods: [...new Set(notifications.map((entry) => entry.method))],
    eventTypes: [...new Set(events.map((event) => event.type))],
    hasIdleStatus: notifications.some((entry) => entry.method === 'session.status' && entry.params.status === 'idle'),
    assistantEvents: events.filter((event) => event.type === 'assistant/message').length
  }
}

async function recordPhase(name, result) {
  const summary = summarize(result.notifications, result.events)
  const row = {
    phase: name,
    passed: result.finalResponse.trim().length > 0 && summary.hasIdleStatus && summary.assistantEvents > 0,
    responseCharacters: result.finalResponse.length,
    eventCount: result.events.length,
    methods: summary.methods,
    eventTypes: summary.eventTypes,
    idleObserved: summary.hasIdleStatus,
    assistantEvents: summary.assistantEvents
  }
  phases.push(row)
  return row
}

let fatal = false
let firstStatus = 'not-run'

// --- process 1: initialize, first prompt, sequential prompt ---
const first = makeHarness()
try {
  await first.start()
  phases.push({ phase: 'initialize', passed: true })
  firstStatus = 'passed'
  if (hasCredential) {
    const handle = first.session()
    sessionId = handle.id
    const firstRun = await handle.run(`Remember this token for later: ${memoryToken}. Reply with one short sentence.`, { onNotification: () => {} })
    const firstRow = await recordPhase('first-prompt', firstRun)
    const sequential = await handle.run('What token did I ask you to remember? Reply with only that token.')
    const sequentialRow = await recordPhase('sequential-prompt', sequential)
    phases.push({ phase: 'sequential-context-inherited', passed: sequentialRow.passed && sequential.finalResponse.includes(memoryToken) })
    if (!firstRow.passed) fatal = true
  }
} catch (error) {
  firstStatus = 'failed'
  fatal = true
  phases.push({ phase: 'process1', passed: false, error: String(error?.message ?? error).slice(0, 200) })
} finally {
  await first.close().catch(() => {})
  phases.push({ phase: 'first-close', passed: true })
}

// --- process 2: resume after restart ---
if (hasCredential && sessionId && !fatal) {
  const second = makeHarness()
  try {
    await second.start()
    const resumed = second.session(sessionId)
    const resumedResult = await resumed.run('What token did I ask you to remember before restart? Reply with only that token.')
    const row = await recordPhase('resume-after-restart', resumedResult)
    phases.push({ phase: 'resume-context-inherited', passed: row.passed && resumedResult.finalResponse.includes(memoryToken) })
  } catch (error) {
    phases.push({ phase: 'resume-after-restart', passed: false, error: String(error?.message ?? error).slice(0, 200) })
    fatal = true
  } finally {
    await second.close().catch(() => {})
  }
}

const failed = phases.some((phase) => phase.passed === false)
if (!hasCredential) {
  console.log(JSON.stringify({ status: 'partial', reason: 'DEEPSEEK_API_KEY is absent; prompt and resume probes skipped', workspacePath, dshHome, phases }, null, 2))
  process.exitCode = 2
} else {
  console.log(JSON.stringify({ status: failed ? 'failed' : 'passed', workspacePath, dshHome, sessionId, firstStatus, phases }, null, 2))
  process.exitCode = failed ? 1 : 0
}
