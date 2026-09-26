/**
 * Phase 1 / Phase 3 sampling probe: drive the real installed DSH over the
 * public ACP transport, capture exactly which tool-call fields the protocol
 * actually provides, and try to obtain real terminal output + exit codes via
 * `terminal/output` and `terminal/wait_for_exit`.
 *
 * Also serves as the shell-execution isolation test: the same explicit shell
 * task is run (a) directly through Node, (b) through DSH ACP under plain Node,
 * so a `0xC0000142`/`3221225794` style failure can be pinned to the right layer.
 *
 *   TEMPORAL_TEST_API_KEY=... TEMPORAL_TEST_BASE_URL=... \
 *   TEMPORAL_TEST_PROVIDER=volc-ark TEMPORAL_TEST_MODEL=deepseek-v4-flash \
 *   node scripts/probes/dsh-tooltrace-impl.mjs
 *
 * Prints only sanitized facts: field-presence flags, tool kinds/names
 * (truncated), terminal/exit-capability flags, file-exists booleans and
 * bounded lengths. Never prints the credential, raw model text or raw output.
 */
import { createRequire } from 'node:module'
import { spawn } from 'node:child_process'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, mkdir, writeFile, readFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, '..', '..')
const require = createRequire(import.meta.url)
const run = promisify(execFile)

const provider = process.env.TEMPORAL_TEST_PROVIDER ?? 'volc-ark'
const model = process.env.TEMPORAL_TEST_MODEL ?? 'deepseek-v4-flash'
const baseUrl = process.env.TEMPORAL_TEST_BASE_URL ?? (provider === 'volc-ark' ? 'https://ark.cn-beijing.volces.com/api/plan/v3' : undefined)
const credential = process.env.TEMPORAL_TEST_API_KEY ?? process.env.DEEPSEEK_API_KEY ?? process.env.VOLC_ARK_API_KEY

const evidence = { provider, model, hasBaseUrl: Boolean(baseUrl), hasCredential: Boolean(credential) }
if (!credential) {
  console.log(JSON.stringify({ ...evidence, status: 'skipped', reason: 'credential absent' }, null, 2))
  process.exit(2)
}

const dshManifest = require.resolve('@deepseek-ai/dsh/package.json')
const dshBin = join(dirname(dshManifest), 'lib', 'bin.js')

const root = await mkdtemp(join(tmpdir(), 'temporal-tooltrace-'))
const dshHome = join(root, 'dsh-home')
await mkdir(dshHome, { recursive: true })
process.env.DSH_HOME = dshHome
const workspace = join(root, 'workspace')
await mkdir(workspace, { recursive: true })
const marker = `tooltrace-${randomUUID().slice(0, 8)}`

// ---------------------------------------------------------------------------
// (a) System-level control: Node itself can spawn cmd and run the verify chain.
// ---------------------------------------------------------------------------
let systemShell = 'not-run'
try {
  await writeFile(join(workspace, 'NOTES.md'), marker + '\n')
  const { stdout } = await run('cmd', ['/c', `echo test-verify && type NOTES.md`], { cwd: workspace, windowsHide: true })
  systemShell = `ok stdout=${stdout.trim().length}`
} catch (error) {
  systemShell = `failed ${error?.code ?? '?'}`
}

// ---------------------------------------------------------------------------
// (b) DSH ACP under plain Node: what does the public protocol actually expose?
// ---------------------------------------------------------------------------
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
await writeFile(patchPath, patch)

const child = spawn(process.execPath, [dshBin, '--profile', 'acp', '--patch', patchPath], {
  cwd: workspace,
  env: { ...process.env, DSH_PERMISSION_MODE: 'workspace-write', TEMPORAL_LLM_API_KEY: credential },
  stdio: ['pipe', 'pipe', 'pipe']
})
let stderr = ''
child.stderr.on('data', (chunk) => { stderr = (stderr + chunk.toString()).slice(-4000) })

const { Readable, Writable } = await import('node:stream')
const acp = await import('@agentclientprotocol/sdk')

const app = acp.client({ name: 'temporal-tooltrace-probe' })
const toolCalls = new Map() // toolCallId -> trace
const toolKinds = new Set()
const toolNames = new Set()
const sawTerminalBlock = new Set()
const terminalResults = []
let terminalOutputCapable = 'not-tried'
let waitForExitCapable = 'not-tried'
let permissionsAsked = 0
let modelTextLength = 0
let activeSessionId = null
const modelDllCodes = new Set()
let modelMentionsDllError = false

function extractTerminalId(update) {
  const content = update.content
  if (!Array.isArray(content)) return undefined
  for (const block of content) {
    if (block && block.type === 'terminal' && block.terminalId) return block.terminalId
    if (block && typeof block === 'object' && block.terminalId) return block.terminalId
  }
  return undefined
}

// Handlers are registered BEFORE connect: the SDK snapshots them at connect.
const pendingTools = new Map()
app.onRequest('session/request_permission', ({ params }) => {
  permissionsAsked += 1
  const options = params.options ?? []
  const allow = options.find((o) => o.kind === 'allow_once') ?? options.find((o) => o.kind === 'allow_always')
  if (allow) return { outcome: { outcome: 'selected', optionId: allow.optionId } }
  return { outcome: { outcome: 'cancelled' } }
})
app.onNotification('session/update', ({ params }) => {
  const sessionId = activeSessionId
  if (!sessionId || params.sessionId !== sessionId) return
  const update = params.update
  if (!update || typeof update !== 'object') return
  const kind = update.sessionUpdate
  if (kind === 'agent_message_chunk') {
    if (update.content?.type === 'text') {
      const chunk = update.content.text ?? ''
      modelTextLength += chunk.length
      const m = chunk.match(/0xC[0-9A-Fa-f]+|\b32\d{7}\b|DLL|STATUS_[A-Z_]+/)
      if (m) {
        modelDllCodes.add(m[0].slice(0, 24))
        modelMentionsDllError = true
      }
    }
    return
  }
  if (kind === 'tool_call') {
    toolKinds.add(update.kind ?? '?')
    if (update.name) toolNames.add(update.name)
    pendingTools.set(update.toolCallId, { kind: update.kind ?? '?', name: update.name ?? '', title: (update.title ?? '').slice(0, 24) })
    return
  }
  if (kind === 'tool_call_update') {
    const id = update.toolCallId
    const prev = pendingTools.get(id) ?? { kind: update.kind ?? '?', name: '', title: '' }
    toolKinds.add(update.kind ?? prev.kind)
    if (update.name) toolNames.add(update.name)
    if (!pendingTools.has(id)) pendingTools.set(id, prev)
    const title = (update.title ?? '').slice(0, 24) || prev.title
    const status = update.status ?? '?'
    const terminalId = extractTerminalId(update)
    const rawInput = update.rawInput
    const rawOutput = update.rawOutput
    toolCalls.set(id, {
      kind: update.kind ?? prev.kind,
      title,
      status,
      terminalId,
      hasRawInput: rawInput !== undefined,
      rawInputType: rawInput === null ? 'null' : typeof rawInput,
      rawInputLooksCommand: typeof rawInput === 'string' && /cmd|powershell|pwsh|bash|sh\b/i.test(rawInput.slice(0, 200)),
      rawInputLen: typeof rawInput === 'string' ? rawInput.length : (typeof rawInput === 'object' && rawInput !== null ? 0 : undefined),
      rawOutputLen: typeof rawOutput === 'string' ? rawOutput.length : undefined,
      rawOutputIsJson: typeof rawOutput === 'object' && rawOutput !== null,
      contentTypes: Array.isArray(update.content) ? update.content.map((b) => (b && typeof b === 'object' ? b.type : typeof b)).filter(Boolean) : []
    })
    if (terminalId) sawTerminalBlock.add(terminalId)
    return
  }
})

const connection = app.connect(acp.ndJsonStream(
  Writable.toWeb(child.stdin),
  Readable.toWeb(child.stdout)
))

await connection.agent.request('initialize', { protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} })

const created = await connection.agent.request('session/new', { cwd: workspace, mcpServers: [] })
const sessionId = created.sessionId
activeSessionId = sessionId

const prompt = [
  `Create a file named NOTES.md in the current workspace whose entire contents are exactly the single line: ${marker}.`,
  'Then run this exact shell command and verify it succeeds: cmd /c echo test-verify && type NOTES.md',
  'If the command succeeded, reply with exactly: done'
].join(' ')

const started = Date.now()
let timedOut = false
try {
  await connection.agent.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: prompt }] })
} catch (error) {
  evidence.promptError = String(error?.message ?? error).replace(/\s+/g, ' ').slice(0, 300)
}

// Give the notification dispatcher a beat to flush tool_call_update events.
await new Promise((resolve) => setTimeout(resolve, 1500))

// Now resolve terminals: try terminal/output then terminal/wait_for_exit for
// every terminal block we saw, recording whether the public requests work.
for (const terminalId of sawTerminalBlock) {
  let output = null
  let exit = null
  try {
    const resp = await connection.agent.request('terminal/output', { sessionId, terminalId })
    terminalOutputCapable = 'yes'
    output = resp
  } catch (error) {
    terminalOutputCapable = terminalOutputCapable === 'not-tried' ? 'no' : terminalOutputCapable
  }
  try {
    const resp = await connection.agent.request('terminal/wait_for_exit', { sessionId, terminalId })
    waitForExitCapable = 'yes'
    exit = resp
  } catch (error) {
    waitForExitCapable = waitForExitCapable === 'not-tried' ? 'no' : waitForExitCapable
  }
  terminalResults.push({
    terminalIdLen: terminalId.length,
    outputCapable: Boolean(output),
    outputLen: output?.output?.length ?? null,
    exitCode: exit?.exitCode ?? null,
    exitSignal: exit?.signal ?? null
  })
}

try { await connection.agent.request('session/close', { sessionId }) } catch { /* ignore */ }
connection.close()
if (child.exitCode === null) {
  try { child.stdin.end() } catch { /* ignore */ }
  await new Promise((resolve) => { child.once('exit', resolve); setTimeout(resolve, 6000).unref?.() })
  if (child.exitCode === null) child.kill('SIGKILL')
}

let fileCreated = false
try { fileCreated = (await stat(join(workspace, 'NOTES.md'))).isFile() } catch { fileCreated = false }

const summary = {
  ...evidence,
  elapsedMs: Date.now() - started,
  systemShell,
  dsh: {
    toolCallIds: [...toolCalls.keys()].length,
    toolKinds: [...toolKinds].sort(),
    toolNames: [...toolNames].map((n) => n.slice(0, 40)).sort(),
    statuses: [...new Set([...toolCalls.values()].map((t) => t.status))].sort(),
    toolTitles: [...new Set([...toolCalls.values()].map((t) => t.title))].sort(),
    calls: [...toolCalls.entries()].map(([id, t]) => `${id.slice(0, 8)}:${t.title}@${t.status}`).sort(),
    rawInputObserved: [...new Set([...toolCalls.values()].map((t) => t.hasRawInput))].sort(),
    rawInputTypes: [...new Set([...toolCalls.values()].map((t) => t.rawInputType))].sort(),
    rawInputCommandLike: [...toolCalls.values()].filter((t) => t.rawInputLooksCommand).length,
    rawInputLenRange: lenRange([...toolCalls.values()].map((t) => t.rawInputLen).filter((n) => n !== undefined)),
    rawOutputLenRange: lenRange([...toolCalls.values()].map((t) => t.rawOutputLen).filter((n) => n !== undefined)),
    rawOutputIsJson: [...toolCalls.values()].filter((t) => t.rawOutputIsJson).length,
    sawTerminalBlocks: sawTerminalBlock.size,
    terminalOutputCapable,
    waitForExitCapable,
    terminalResults,
    permissionsAsked,
    fileCreated,
    modelTextLength,
    modelMentionsDllError,
    modelDllCodes: [...modelDllCodes].sort()
  },
  stderrTailLen: stderr.trim().length,
  stderrSample: stderr.trim().replace(/\s+/g, ' ').slice(-240)
}

console.log(JSON.stringify(summary, null, 2))
process.exit(0)

function titleRange(lengths) {
  if (lengths.length === 0) return [0, 0]
  return [Math.min(...lengths), Math.max(...lengths)]
}
function lenRange(numbers) {
  if (numbers.length === 0) return [0, 0]
  return [Math.min(...numbers), Math.max(...numbers)]
}
