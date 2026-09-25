/**
 * Phase-2 probe: does ACP `session/resume` continue context across processes?
 *
 *   DEEPSEEK_API_KEY=... node scripts/probes/dsh-acp-resume.mjs
 *
 * Prints only booleans and counts — never the token, credential, or content.
 */
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdtemp, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { Readable, Writable } from 'node:stream'
import { client, ndJsonStream, PROTOCOL_VERSION } from '@agentclientprotocol/sdk'

const require = createRequire(import.meta.url)
const dshBin = join(require.resolve('@deepseek-ai/dsh/package.json'), '..', 'lib', 'bin.js')
const root = await mkdtemp(join(tmpdir(), 'temporal-acp-resume-'))
const dshHome = join(root, 'dsh-home')
const workspace = join(root, 'workspace')
await mkdir(workspace, { recursive: true })
const token = `acp-resume-${randomUUID().slice(0, 8)}`
const hasKey = Boolean(process.env.DEEPSEEK_API_KEY)

function spawnAcp() {
  const child = spawn(process.execPath, [dshBin, '--profile', 'acp'], {
    cwd: workspace,
    env: { ...process.env, DSH_HOME: dshHome },
    stdio: ['pipe', 'pipe', 'pipe']
  })
  child.stderr.on('data', () => {})
  return child
}

async function withAcp(fn) {
  const child = spawnAcp()
  const chunks = []
  try {
    return await client({ name: 'resume-probe' })
      .onNotification('session/update', ({ params }) => {
        const update = params?.update
        if (update?.sessionUpdate === 'agent_message_chunk' && update.content?.type === 'text') chunks.push(update.content.text)
      })
      .connectWith(ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout)), async (ctx) => {
        await ctx.request('initialize', { protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
        return fn(ctx, chunks)
      })
  } finally {
    child.stdin.end()
    await new Promise((resolve) => { const t = setTimeout(() => { child.kill('SIGKILL'); resolve() }, 10_000); child.once('exit', () => { clearTimeout(t); resolve() }) })
  }
}

const evidence = { hasKey }
if (!hasKey) {
  console.log(JSON.stringify({ ...evidence, status: 'skipped', reason: 'DEEPSEEK_API_KEY absent' }, null, 2))
  process.exitCode = 2
} else {
  let sessionId
  await withAcp(async (ctx, chunks) => {
    const created = await ctx.request('session/new', { cwd: workspace, mcpServers: [] })
    sessionId = created.sessionId
    const turn = await ctx.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: `Remember this token: ${token}. Reply with one short sentence.` }] })
    evidence.create = { stopReason: turn.stopReason, chunkChars: chunks.join('').length }
    await ctx.request('session/close', { sessionId })
  })

  await withAcp(async (ctx, chunks) => {
    const resumed = await ctx.request('session/resume', { sessionId, cwd: workspace, mcpServers: [] })
    evidence.resume = { ok: Boolean(resumed) }
    const turn = await ctx.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'What token did I ask you to remember before restart? Reply with only that token.' }] })
    const text = chunks.join('')
    evidence.resumeContext = { stopReason: turn.stopReason, chunkChars: text.length, hasToken: text.includes(token) }
  })
  console.log(JSON.stringify(evidence, null, 2))
  if (!evidence.resumeContext?.hasToken) process.exitCode = 1
}
