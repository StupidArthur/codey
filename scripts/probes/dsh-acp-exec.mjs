/**
 * Phase-A spike: drive a real model through the public ACP profile for
 * execution (create + sequential + cross-process resume), including a file
 * write that may trigger session/request_permission.
 *
 *   DEEPSEEK_API_KEY=... node scripts/probes/dsh-acp-exec.mjs
 *
 * Prints only counts, kinds, booleans and the requested provider/model — no
 * prompts, model answers or credentials.
 */
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdtemp, mkdir, readFile, writeFile, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable, Writable } from 'node:stream'
import { client, ndJsonStream, PROTOCOL_VERSION } from '@agentclientprotocol/sdk'

const require = createRequire(import.meta.url)
const dshBin = join(require.resolve('@deepseek-ai/dsh/package.json'), '..', 'lib', 'bin.js')
const root = await mkdtemp(join(tmpdir(), 'temporal-acp-exec-'))
const dshHome = join(root, 'dsh-home')
const workspace = join(root, 'workspace')
await mkdir(workspace, { recursive: true })
const provider = process.env.P0_PROVIDER ?? 'deepseek-official'
const model = process.env.P0_MODEL ?? 'deepseek-v4-flash'
const hasKey = Boolean(process.env.DEEPSEEK_API_KEY)
const patchPath = join(root, 'acp.patch.yml')
await writeFile(patchPath, `- id: acp\n  config:\n    provider: ${provider}\n    model: ${model}\n`)

function spawnAcp() {
  const child = spawn(process.execPath, [dshBin, '--profile', 'acp', '--patch', patchPath], {
    cwd: workspace,
    env: { ...process.env, DSH_HOME: dshHome },
    stdio: ['pipe', 'pipe', 'pipe']
  })
  let stderr = ''
  child.stderr.on('data', (chunk) => { stderr += String(chunk) })
  return { child, stderr: () => stderr }
}

function shortId(id) {
  return typeof id === 'string' ? `${id.slice(0, 8)}…(${id.length})` : String(id)
}

async function withAcp(fn) {
  const { child } = spawnAcp()
  const updates = []
  const assistant = []
  const permissions = []
  try {
    return await client({ name: 'exec-spike' })
      .onNotification('session/update', ({ params }) => {
        const update = params?.update
        if (!update || typeof update !== 'object') return
        updates.push(update.sessionUpdate)
        if (update.sessionUpdate === 'agent_message_chunk' && update.content?.type === 'text') assistant.push(update.content.text)
      })
      .onRequest('session/request_permission', ({ params }) => {
        const options = params?.options ?? []
        permissions.push({ tool: params?.toolCall?.title ?? params?.toolCall?.kind ?? 'unknown', kinds: options.map((o) => o.kind) })
        const allow = options.find((o) => o.kind === 'allow_once') ?? options.find((o) => o.kind === 'allow_always')
        return allow ? { outcome: { outcome: 'selected', optionId: allow.optionId } } : { outcome: { outcome: 'cancelled' } }
      })
      .connectWith(ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout)), async (ctx) => {
        await ctx.request('initialize', { protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
        return fn(ctx, { updates, assistant, permissions })
      })
  } finally {
    child.stdin.end()
    await new Promise((resolve) => { const t = setTimeout(() => { child.kill('SIGKILL'); resolve() }, 10_000); child.once('exit', () => { clearTimeout(t); resolve() }) })
  }
}

const evidence = { hasKey, provider, model, patchApplied: true }
if (!hasKey) {
  console.log(JSON.stringify({ ...evidence, status: 'skipped', reason: 'DEEPSEEK_API_KEY absent' }, null, 2))
  process.exitCode = 2
} else {
  let sessionId
  await withAcp(async (ctx, { updates, assistant, permissions }) => {
    const created = await ctx.request('session/new', { cwd: workspace, mcpServers: [] })
    sessionId = created.sessionId
    evidence.newSession = { id: shortId(created.sessionId), configOptions: (created.configOptions ?? []).map((o) => o.id) }
    const writeTurn = await ctx.request('session/prompt', {
      sessionId,
      prompt: [{ type: 'text', text: 'Create a file named p0-artifact.txt in the current working directory containing exactly the word temporal. Then reply with only: done.' }]
    })
    evidence.writeTurn = { stopReason: writeTurn.stopReason, permissionRequests: permissions.length, updateKinds: [...new Set(updates)] }
    try { await access(join(workspace, 'p0-artifact.txt')); evidence.fileCreated = true } catch { evidence.fileCreated = false }
    const seq = await ctx.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'What single word did you write into p0-artifact.txt? Reply with only that word.' }] })
    evidence.sequential = { stopReason: seq.stopReason, hasWord: assistant.join('').toLowerCase().includes('temporal') }
  })

  await withAcp(async (ctx, { updates, assistant }) => {
    await ctx.request('session/resume', { sessionId, cwd: workspace, mcpServers: [] })
    const turn = await ctx.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'Earlier you wrote one word into a file. Reply with only that word.' }] })
    evidence.resume = { stopReason: turn.stopReason, hasWord: assistant.join('').toLowerCase().includes('temporal'), updateKinds: [...new Set(updates)] }
  })
  try { evidence.fileContent = (await readFile(join(workspace, 'p0-artifact.txt'), 'utf8')).trim().slice(0, 20) } catch { evidence.fileContent = null }
  console.log(JSON.stringify(evidence, null, 2))
}
