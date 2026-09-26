/**
 * Probes the installed DSH's public ACP capabilities against the frozen
 * provider configuration. Everything printed is capability names, ids,
 * booleans and counts — never model text or credentials.
 *
 *   node scripts/probes/dsh-capabilities.mjs
 *
 * Checks:
 *  1. initialize → agentCapabilities (loadSession, prompt capabilities, modes flag)
 *  2. session/new → modes (availableModes ids), configOptions, capabilities
 *  3. session/set_mode → switch to a plan-like mode and back (when exposed)
 *  4. session/cancel → does an in-flight turn actually stop (public baseline),
 *     and does the session stay usable afterwards
 *  5. one shell-tool turn under workspace-write: which tool_call update
 *     content types DSH emits (terminal/output? exit status?) — structure only
 */
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Readable, Writable } from 'node:stream'

const require = createRequire(import.meta.url)
const manifest = require.resolve('@deepseek-ai/dsh/package.json')
const dshBin = join(dirname(manifest), 'lib', 'bin.js')

const provider = process.env.TEMPORAL_TEST_PROVIDER ?? 'volc-ark'
const model = process.env.TEMPORAL_TEST_MODEL ?? 'deepseek-v4-flash'
const baseUrl = process.env.TEMPORAL_TEST_BASE_URL ?? 'https://ark.cn-beijing.volces.com/api/plan/v3'
const credential = process.env.TEMPORAL_TEST_API_KEY ?? process.env.DEEPSEEK_API_KEY ?? process.env.VOLC_ARK_API_KEY
if (!credential) { console.log(JSON.stringify({ status: 'skipped', reason: 'no credential in env' })); process.exit(2) }

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const report = { provider, model }

const patchDir = await mkdtemp(join(tmpdir(), 'temporal-cap-'))
const patchPath = join(patchDir, 'profile.patch.yml')
const yamlScalar = (value) => `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
const patch = [
  '- id: llm-pi-ai',
  '  config:',
  '    providers:',
  `      ${yamlScalar(provider)}:`,
  `        displayName: ${yamlScalar(provider)}`,
  '        apiKeyEnv: TEMPORAL_LLM_API_KEY',
  '        api: openai-completions',
  `        baseURL: ${yamlScalar(baseUrl)}`,
  '        models:',
  `          - id: ${yamlScalar(model)}`,
  `            name: ${yamlScalar(model)}`,
  '            contextWindow: 131072',
  '            maxTokens: 32768',
  '- id: acp',
  '  config:',
  `    provider: ${yamlScalar(provider)}`,
  `    model: ${yamlScalar(model)}`
].join('\n') + '\n'
await writeFile(patchPath, patch)

const workspace = await mkdtemp(join(tmpdir(), 'temporal-cap-ws-'))
const env = { ...process.env, TEMPORAL_LLM_API_KEY: credential, DSH_PERMISSION_MODE: 'workspace-write' }
if (process.versions.electron) env.ELECTRON_RUN_AS_NODE = '1'
const child = spawn(process.execPath, [dshBin, '--profile', 'acp', '--patch', patchPath], {
  cwd: workspace, env, stdio: ['pipe', 'pipe', 'pipe']
})
let stderrTail = ''
child.stderr.on('data', (chunk) => { stderrTail = (stderrTail + chunk.toString()).slice(-2000) })

const acp = await import('@agentclientprotocol/sdk')
const updates = []
const permissionRequests = []
const app = acp.client({ name: 'temporal-capabilities' })
  .onNotification('session/update', ({ params }) => {
    const update = params.update
    const entry = { kind: update.sessionUpdate }
    if (update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update') {
      entry.kind2 = update.kind
      entry.status = update.status
      entry.contentTypes = (update.content ?? []).map((item) => item.type)
      entry.rawOutput = update.rawOutput !== undefined
      entry.locations = (update.locations ?? []).length
    }
    if (update.sessionUpdate === 'current_mode_update') entry.currentModeId = update.currentModeId
    updates.push(entry)
  })
  .onRequest('session/request_permission', ({ params }) => {
    permissionRequests.push({ kinds: (params.options ?? []).map((option) => option.kind), toolKind: params.toolCall?.kind })
    const allow = (params.options ?? []).find((option) => option.kind === 'allow_once')
      ?? (params.options ?? []).find((option) => option.kind === 'allow_always')
    if (allow) return { outcome: { outcome: 'selected', optionId: allow.optionId } }
    const reject = (params.options ?? []).find((option) => option.kind === 'reject_once')
    return reject ? { outcome: { outcome: 'selected', optionId: reject.optionId } } : { outcome: { outcome: 'cancelled' } }
  })

const connection = app.connect(acp.ndJsonStream(
  Writable.toWeb(child.stdin), Readable.toWeb(child.stdout)
))

try {
  const init = await connection.agent.request('initialize', {
    protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {}
  })
  report.agentCapabilities = init.agentCapabilities ?? {}
  report.protocolVersion = init.protocolVersion

  const created = await connection.agent.request('session/new', { cwd: workspace, mcpServers: [] })
  report.sessionNewKeys = Object.keys(created).sort()
  report.modes = created.modes ?? null
  report.configOptions = created.configOptions
    ? (created.configOptions ?? []).map((group) => ({ id: group.id, name: group.name, options: (group.options ?? []).map((option) => ({ id: option.id, name: option.name, kind: option.kind, current: option.current ?? option.value })) }))
    : null
  report.sessionCapabilities = created.capabilities ?? null
  const sessionId = created.sessionId

  // 3. set_mode when modes are exposed
  if (created.modes?.availableModes?.length) {
    const ids = created.modes.availableModes.map((mode) => mode.id)
    report.availableModeIds = ids
    const target = ids.find((id) => /plan/i.test(id)) ?? ids[0]
    try {
      await connection.agent.request('session/set_mode', { sessionId, modeId: target })
      report.setMode = { target, ok: true }
      const back = created.modes.currentModeId
      await connection.agent.request('session/set_mode', { sessionId, modeId: back })
      report.setModeBack = { target: back, ok: true }
    } catch (error) {
      report.setMode = { target, ok: false, error: String(error?.message ?? error).slice(0, 200) }
    }
  } else {
    report.setMode = { ok: false, reason: 'session/new exposes no modes' }
  }

  // 4. cancel test: a deliberately long turn, cancel after ~6s, race the reply
  {
    let settled = false
    const promptPromise = connection.agent.request('session/prompt', {
      sessionId,
      prompt: [{ type: 'text', text: 'Count slowly from 1 to 40: output one number, then wait about one second before the next number. Do not use any tools.' }]
    }).then(
      (result) => ({ settled: true, stopReason: result?.stopReason ?? null }),
      (error) => ({ settled: true, error: String(error?.message ?? error).slice(0, 160) })
    ).then((value) => { settled = true; return value })
    await sleep(6000)
    const cancelAtMs = Date.now()
    let cancelSent = false
    try {
      await connection.agent.notify('session/cancel', { sessionId })
      cancelSent = true
    } catch (error) {
      report.cancelError = String(error?.message ?? error).slice(0, 160)
    }
    const outcome = await Promise.race([
      promptPromise,
      sleep(45000).then(() => ({ settled: false, timedOut: true }))
    ])
    report.cancel = {
      cancelSent,
      promptResolved: Boolean(outcome.settled),
      stopReason: outcome.stopReason ?? null,
      resolvedWithinMs: outcome.settled ? Date.now() - cancelAtMs : null,
      note: outcome.timedOut ? 'prompt did not settle within 45s after cancel' : undefined
    }
    if (!settled) { /* unreachable */ }
  }

  // 5. session still usable after cancel?
  try {
    const second = await connection.agent.request('session/prompt', {
      sessionId,
      prompt: [{ type: 'text', text: 'Reply with the single word ok.' }]
    })
    report.sessionUsableAfterCancel = { ok: true, stopReason: second?.stopReason ?? null }
  } catch (error) {
    report.sessionUsableAfterCancel = { ok: false, error: String(error?.message ?? error).slice(0, 160) }
  }

  // 6. shell tool turn: structure of tool_call updates under workspace-write
  try {
    await connection.agent.request('session/prompt', {
      sessionId,
      prompt: [{ type: 'text', text: 'Run exactly this shell command: cmd /c echo cap-probe-ok. Then reply with the exit code only.' }]
    })
    report.shellToolUpdates = updates.filter((update) => update.kind?.startsWith?.('tool') || update.kind === 'tool_call' || update.kind === 'tool_call_update')
    report.permissionRequestCount = permissionRequests.length
    report.permissionRequests = permissionRequests
    report.updateKinds = [...new Set(updates.map((update) => update.kind))]
    report.toolContentTypes = [...new Set(updates.flatMap((update) => update.contentTypes ?? []))]
    report.toolRawOutputSeen = updates.some((update) => update.rawOutput)
  } catch (error) {
    report.shellTurnError = String(error?.message ?? error).slice(0, 160)
  }

  await connection.agent.request('session/close', { sessionId })
  report.status = 'probed'
} catch (error) {
  report.status = 'failed'
  report.error = String(error?.message ?? error).slice(0, 300)
  if (stderrTail.trim()) report.stderrTail = stderrTail.trim().slice(-400)
} finally {
  connection.close()
  try { child.stdin.end() } catch { /* gone */ }
  await rm(patchDir, { recursive: true, force: true }).catch(() => {})
}

console.log(JSON.stringify(report, null, 2))
process.exit(report.status === 'probed' ? 0 : 1)
