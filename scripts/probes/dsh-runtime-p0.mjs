/**
 * P0 SDK contract probe. Run with:
 *   node scripts/probes/dsh-runtime-p0.mjs
 *   DEEPSEEK_API_KEY=... node scripts/probes/dsh-runtime-p0.mjs
 *
 * One Node host process runs the whole probe. It creates two DeepSeekHarness
 * instances in sequence; each harness starts its own `dsh --profile sdk`
 * runtime subprocess pointing at the same temporary DSH home. The second
 * harness is the cross-process (new runtime subprocess) resume attempt.
 *
 * Prints only phase status, session id, event kinds/counts, JSON-RPC error
 * fields and sanitized assertions. Error text is redacted for credential-like
 * environment values and the probe's own memory token, then flattened and
 * truncated. The probe never prints prompts or model responses.
 *
 * Exit codes: 0 = all phases passed; 1 = a phase failed (including pre-model
 * phases without a credential); 2 = skipped because no credential was present
 * and every phase that did run passed.
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
let fatal = false
const memoryToken = `p0-${randomUUID().slice(0, 8)}`

function makeHarness() {
  return new DeepSeekHarness({
    profile: 'sdk', cwd: workspacePath, processCwd: workspacePath,
    dshHome, provider, model,
    initializeTimeoutMs: 60_000
  })
}

/** Values that must never appear even inside a truncated error message. */
const secrets = [...new Set([
  memoryToken,
  ...Object.entries(process.env)
    .filter(([key, value]) => typeof value === 'string' && value.length >= 8 && /(API_?KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/i.test(key))
    .map(([, value]) => value)
])].filter((value) => value.length > 0)

/** Redact known secrets, then flatten newlines and truncate. */
function sanitize(text) {
  let out = String(text)
  for (const secret of secrets) out = out.split(secret).join('[redacted]')
  return out.replace(/[\r\n]+/g, ' ').slice(0, 200)
}

/** Record only the fields the thrown error actually exposes. */
function describeError(error) {
  const described = { name: typeof error?.name === 'string' && error.name ? error.name : 'Error' }
  if (typeof error?.code === 'number') described.code = error.code
  if (typeof error?.message === 'string') described.message = sanitize(error.message)
  return described
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

/** A close phase is only `passed: true` when close() actually resolved. */
async function recordClose(harness, phaseName) {
  try {
    await harness.close()
    phases.push({ phase: phaseName, passed: true })
  } catch (error) {
    phases.push({ phase: phaseName, passed: false, ...describeError(error) })
    fatal = true
  }
}

// --- runtime subprocess 1: initialize, first prompt, sequential prompt ---
const first = makeHarness()
try {
  await first.start()
  phases.push({ phase: 'initialize', passed: true })
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
  fatal = true
  phases.push({ phase: 'subprocess1', passed: false, ...describeError(error) })
} finally {
  await recordClose(first, 'first-close')
}

// --- runtime subprocess 2: resume after the runtime subprocess was replaced ---
if (hasCredential && sessionId && !fatal) {
  const second = makeHarness()
  try {
    await second.start()
    const resumed = second.session(sessionId)
    const resumedResult = await resumed.run('What token did I ask you to remember before restart? Reply with only that token.')
    const row = await recordPhase('resume-after-restart', resumedResult)
    phases.push({ phase: 'resume-context-inherited', passed: row.passed && resumedResult.finalResponse.includes(memoryToken) })
  } catch (error) {
    phases.push({ phase: 'resume-after-restart', passed: false, ...describeError(error) })
    fatal = true
  } finally {
    await recordClose(second, 'second-close')
  }
}

const failed = phases.some((phase) => phase.passed === false)
if (!hasCredential) {
  console.log(JSON.stringify({
    status: failed ? 'failed' : 'partial',
    reason: failed
      ? 'a pre-model phase failed before credential-gated phases could run'
      : 'DEEPSEEK_API_KEY is absent; prompt and resume probes skipped',
    workspacePath, dshHome, phases
  }, null, 2))
  process.exitCode = failed ? 1 : 2
} else {
  console.log(JSON.stringify({ status: failed ? 'failed' : 'passed', workspacePath, dshHome, sessionId, phases }, null, 2))
  process.exitCode = failed ? 1 : 0
}
