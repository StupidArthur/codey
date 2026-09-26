/**
 * Phase 3 probe: reproduce the intermittent `0xC0000142`/`3221225794`
 * (STATUS_DLL_INIT_FAILED) pwsh failure inside DSH's shell tool and capture
 * sanitized facts, while proving the same pwsh command works at the system
 * layer under plain Node.
 *
 *   TEMPORAL_TEST_API_KEY=... node scripts/probes/pwsh-repro-impl.mjs
 *
 * Prints only sanitized facts: per-round tool title/status, error-code
 * fragments observed in model text, system pwsh result. Never the credential.
 */
import { createRequire } from 'node:module'
import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, '..', '..')
const require = createRequire(import.meta.url)
const run = promisify(execFile)

const provider = process.env.TEMPORAL_TEST_PROVIDER ?? 'volc-ark'
const model = process.env.TEMPORAL_TEST_MODEL ?? 'deepseek-v4-flash'
const baseUrl = process.env.TEMPORAL_TEST_BASE_URL ?? (provider === 'volc-ark' ? 'https://ark.cn-beijing.volces.com/api/plan/v3' : undefined)
const credential = process.env.TEMPORAL_TEST_API_KEY ?? process.env.DEEPSEEK_API_KEY ?? process.env.VOLC_ARK_API_KEY
const ROUNDS = Number(process.env.TEMPORAL_TEST_ROUNDS ?? 3)

const evidence = { provider, model, rounds: ROUNDS, hasBaseUrl: Boolean(baseUrl), hasCredential: Boolean(credential) }
if (!credential) {
  console.log(JSON.stringify({ ...evidence, status: 'skipped', reason: 'credential absent' }, null, 2))
  process.exit(2)
}

// ---------------------------------------------------------------------------
// (a) System-level control: plain Node spawning pwsh directly.
// ---------------------------------------------------------------------------
let systemPwsh = 'not-run'
try {
  const { stdout } = await run('pwsh', ['-NoProfile', '-Command', 'Write-Output hi'], { windowsHide: true, timeout: 60_000 })
  systemPwsh = `ok stdout=${stdout.trim().length}`
} catch (error) {
  systemPwsh = `failed code=${error?.code ?? '?'} message=${String(error?.message ?? error).replace(/\s+/g, ' ').slice(0, 120)}`
}

// ---------------------------------------------------------------------------
// (b) DSH ACP under plain Node: force pwsh repeatedly and watch for failures.
// ---------------------------------------------------------------------------
const root = await mkdtemp(join(tmpdir(), 'temporal-pwsh-repro-'))
const dshHome = join(root, 'dsh-home')
await mkdir(dshHome, { recursive: true })
process.env.DSH_HOME = dshHome
const workspace = join(root, 'workspace')
await mkdir(workspace, { recursive: true })

const patch = [
  '- id: llm-pi-ai',
  '  config:',
  '    providers:',
  `      "${provider}":`,
  `        displayName: "${provider}"`,
  '        apiKeyEnv: TEMPORAL_LLM_API_KEY',
  '        api: openai-completions',
  `        baseURL: "${baseUrl}"`,
  '        models:',
  `          - id: "${model}"`,
  `            name: "${model}"`,
  '            contextWindow: 131072',
  '            maxTokens: 32768',
  '- id: acp',
  '  config:',
  `    provider: "${provider}"`,
  `    model: "${model}"`,
  ''
].join('\n')
const patchPath = join(root, 'profile.patch.yml')
await require('node:fs/promises').writeFile(patchPath, patch)

const child = spawn(process.execPath, [require.resolve('@deepseek-ai/dsh/package.json').replace(/package\.json$/, 'lib/bin.js'), '--profile', 'acp', '--patch', patchPath], {
  cwd: workspace,
  env: { ...process.env, DSH_PERMISSION_MODE: 'workspace-write', TEMPORAL_LLM_API_KEY: credential },
  stdio: ['pipe', 'pipe', 'pipe']
})
let stderr = ''
child.stderr.on('data', (chunk) => { stderr = (stderr + chunk.toString()).slice(-4000) })

const { Readable, Writable } = await import('node:stream')
const acp = await import('@agentclientprotocol/sdk')
const app = acp.client({ name: 'temporal-pwsh-repro' })

let activeSessionId = null
const perRound = new Map() // round index -> { calls: Map<toolCallId,{title,status}>, dllCodes, mentioned }
const pendingCalls = new Map() // toolCallId -> {title}
let permissionsAsked = 0

app.onRequest('session/request_permission', ({ params }) => {
  permissionsAsked += 1
  const options = params.options ?? []
  const allow = options.find((o) => o.kind === 'allow_once') ?? options.find((o) => o.kind === 'allow_always')
  if (allow) return { outcome: { outcome: 'selected', optionId: allow.optionId } }
  return { outcome: { outcome: 'cancelled' } }
})
app.onNotification('session/update', ({ params }) => {
  if (!activeSessionId || params.sessionId !== activeSessionId) return
  const update = params.update
  if (!update || typeof update !== 'object') return
  const kind = update.sessionUpdate
  const round = perRound.size - 1 // the round currently being prompted
  if (round < 0) return
  const slot = perRound.get(round) ?? { calls: new Map(), dllCodes: new Set(), mentioned: false }
  if (kind === 'agent_message_chunk' && update.content?.type === 'text') {
    const chunk = update.content.text ?? ''
    const m = chunk.match(/0xC[0-9A-Fa-f]{6,8}|\b32\d{7}\b|STATUS_[A-Z_]+|DLL/gi)
    if (m) {
      m.slice(0, 3).forEach((code) => slot.dllCodes.add(code.slice(0, 24)))
      slot.mentioned = true
    }
    perRound.set(round, slot)
    return
  }
  if (kind === 'tool_call') {
    pendingCalls.set(update.toolCallId, { title: (update.title ?? '?').slice(0, 24) })
    slot.calls.set(update.toolCallId, { title: (update.title ?? '?').slice(0, 24), status: 'pending' })
    perRound.set(round, slot)
    return
  }
  if (kind === 'tool_call_update') {
    const prev = pendingCalls.get(update.toolCallId) ?? { title: '?' }
    const title = (update.title ?? prev.title).slice(0, 24)
    const status = update.status ?? '?'
    slot.calls.set(update.toolCallId, { title, status })
    pendingCalls.set(update.toolCallId, { title })
    perRound.set(round, slot)
    return
  }
})

const connection = app.connect(acp.ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout)))
await connection.agent.request('initialize', { protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} })
const created = await connection.agent.request('session/new', { cwd: workspace, mcpServers: [] })
activeSessionId = created.sessionId

const started = Date.now()
let timedOut = false
for (let i = 0; i < ROUNDS; i += 1) {
  perRound.set(i, { calls: new Map(), dllCodes: new Set(), mentioned: false })
  const promptText = `Run the PowerShell command: pwsh -NoProfile -Command "Write-Output hi" and confirm it actually printed hi. Reply with exactly: ok`
  try {
    await connection.agent.request('session/prompt', { sessionId: activeSessionId, prompt: [{ type: 'text', text: promptText }] })
  } catch (error) {
    evidence.promptError = String(error?.message ?? error).replace(/\s+/g, ' ').slice(0, 300)
  }
  await new Promise((resolve) => setTimeout(resolve, 800))
}

try { await connection.agent.request('session/close', { sessionId: activeSessionId }) } catch { /* ignore */ }
connection.close()
if (child.exitCode === null) {
  try { child.stdin.end() } catch { /* ignore */ }
  await new Promise((resolve) => { child.once('exit', resolve); setTimeout(resolve, 6000).unref?.() })
  if (child.exitCode === null) child.kill('SIGKILL')
}

const rounds = [...perRound.entries()].map(([i, slot]) => ({
  round: i + 1,
  calls: [...slot.calls.values()].map((c) => `${c.title}@${c.status}`).sort(),
  dllCodes: [...slot.dllCodes].sort(),
  modelMentionsDllError: slot.mentioned
}))

console.log(JSON.stringify({
  ...evidence,
  elapsedMs: Date.now() - started,
  systemPwsh,
  permissionsAsked,
  rounds,
  anyDllFailure: rounds.some((r) => r.modelMentionsDllError),
  stderrTailLen: stderr.trim().length
}, null, 2))
process.exit(0)
