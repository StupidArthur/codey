/**
 * P0 SDK contract probe. Run with:
 *   node scripts/probes/dsh-runtime-p0.mjs
 *   DEEPSEEK_API_KEY=... node scripts/probes/dsh-runtime-p0.mjs
 *
 * A credential enables prompt, sequential prompt and cross-process resume.
 * The script prints only event counts and response lengths, never content or keys.
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
const notifications = []
let sessionId
const memoryToken = `p0-${randomUUID().slice(0, 8)}`

function makeHarness() {
  return new DeepSeekHarness({
    profile: 'sdk', cwd: workspacePath, processCwd: workspacePath,
    dshHome, provider, model,
    initializeTimeoutMs: 30_000
  })
}

function record(name, result) {
  const methods = result.notifications.map((entry) => entry.method)
  const hasIdle = result.notifications.some((entry) =>
    entry.method === 'session.status' &&
    entry.params.sessionId === result.sessionId &&
    entry.params.status === 'idle')
  const assistantEvents = result.events.filter((event) => event.type === 'assistant/message').length
  const row = {
    phase: name, sessionId: result.sessionId,
    responseCharacters: result.finalResponse.length,
    eventCount: result.events.length,
    notificationMethods: [...new Set(methods)],
    idleObserved: hasIdle, assistantEvents
  }
  phases.push(row)
  notifications.push(...result.notifications)
  if (!result.finalResponse.trim() || !hasIdle || assistantEvents === 0) {
    throw new Error(`${name}: missing response, assistant event or idle notification`)
  }
}

let first = makeHarness()
try {
  await first.start()
  phases.push({ phase: 'initialize', passed: true })
  if (!hasCredential) {
    console.log(JSON.stringify({
      status: 'partial', reason: 'DEEPSEEK_API_KEY is absent; prompt and resume probes skipped',
      workspacePath, dshHome, phases
    }, null, 2))
    process.exitCode = 2
  } else {
    const handle = first.session()
    sessionId = handle.id
    record('first-prompt', await handle.run(`Remember this token for later: ${memoryToken}. Reply with one short sentence.`, {
      onNotification: () => {}
    }))
    const sequential = await handle.run('What token did I ask you to remember? Reply with only that token.')
    record('sequential-prompt', sequential)
    if (!sequential.finalResponse.includes(memoryToken)) {
      throw new Error('Sequential prompt did not demonstrate inherited context')
    }
  }
} finally {
  await first.close()
  phases.push({ phase: 'first-close', passed: true })
}

if (hasCredential && sessionId) {
  const second = makeHarness()
  try {
    await second.start()
    const resumed = second.session(sessionId)
    const resumedResult = await resumed.run('What token did I ask you to remember before restart? Reply with only that token.')
    record('resume-after-restart', resumedResult)
    if (!resumedResult.finalResponse.includes(memoryToken)) {
      throw new Error('Resumed session did not demonstrate inherited context')
    }
    console.log(JSON.stringify({
      status: 'passed', workspacePath, dshHome, sessionId, phases,
      notificationCount: notifications.length
    }, null, 2))
  } finally {
    await second.close()
  }
}
