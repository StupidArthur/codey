/**
 * P0 ACP discovery probe. Run with:
 *   node scripts/probes/dsh-acp-discovery.mjs
 *
 * Spawns the public `dsh --profile acp` server, drives it with the public
 * `@agentclientprotocol/sdk` client, and verifies `session/list(cwd)` isolation
 * and cursor pagination. Prints only counts, ids (truncated) and cwd paths —
 * never conversation content or credentials.
 */
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable, Writable } from 'node:stream'
import { client, ndJsonStream, PROTOCOL_VERSION } from '@agentclientprotocol/sdk'

const require = createRequire(import.meta.url)
const dshPkg = require.resolve('@deepseek-ai/dsh/package.json')
const dshBin = join(dshPkg, '..', 'lib', 'bin.js')

const root = await mkdtemp(join(tmpdir(), 'temporal-acp-p0-'))
const dshHome = join(root, 'dsh-home')
const workspaceA = join(root, 'workspace-a')
const workspaceB = join(root, 'workspace-b')
const emptyDir = join(root, 'empty')
await Promise.all([mkdir(workspaceA, { recursive: true }), mkdir(workspaceB, { recursive: true }), mkdir(emptyDir, { recursive: true })])

const pageSize = Number(process.env.P0_ACP_PAGE_SIZE ?? '0') || 0
const patchPath = join(root, 'acp-page-size.patch.yml')
if (pageSize > 0) {
  await writeFile(patchPath, `- id: acp\n  config:\n    sessionListPageSize: ${pageSize}\n`)
}

function spawnAcp() {
  const env = { ...process.env, DSH_HOME: dshHome }
  const args = [dshBin, '--profile', 'acp']
  if (pageSize > 0) args.push('--patch', patchPath)
  const child = spawn(process.execPath, args, {
    cwd: root,
    env,
    stdio: ['pipe', 'pipe', 'pipe']
  })
  let stderr = ''
  child.stderr.on('data', (chunk) => { stderr += String(chunk) })
  return { child, stderr: () => stderr }
}

function shortId(id) {
  return typeof id === 'string' ? `${id.slice(0, 8)}…(${id.length})` : String(id)
}

const evidence = { dshBin, dshHome, workspaces: { workspaceA, workspaceB, emptyDir } }
const { child, stderr } = spawnAcp()
const stream = ndJsonStream(
  Writable.toWeb(child.stdin),
  Readable.toWeb(child.stdout)
)

const created = { a: [], b: [] }
try {
  await client({ name: 'temporal-acp-probe' }).connectWith(stream, async (ctx) => {
    const initialized = await ctx.request('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: {}
    })
    evidence.initialize = {
      protocolVersion: initialized.protocolVersion,
      agentCapabilities: initialized.agentCapabilities ?? null,
      agentInfo: initialized.agentInfo ?? null
    }

    for (let i = 0; i < 3; i += 1) {
      const res = await ctx.request('session/new', { cwd: workspaceA, mcpServers: [] })
      created.a.push(res.sessionId)
    }
    for (let i = 0; i < 2; i += 1) {
      const res = await ctx.request('session/new', { cwd: workspaceB, mcpServers: [] })
      created.b.push(res.sessionId)
    }

    evidence.listAllBeforeClose = (await ctx.request('session/list', {})).sessions.map((s) => shortId(s.sessionId))
    for (const sessionId of [...created.a, ...created.b]) {
      await ctx.request('session/close', { sessionId })
    }

    async function listAll(cwd) {
      const pages = []
      let cursor = null
      for (let guard = 0; guard < 20; guard += 1) {
        const params = {}
        if (cwd) params.cwd = cwd
        if (cursor) params.cursor = cursor
        const res = await ctx.request('session/list', params)
        pages.push({ count: res.sessions.length, ids: res.sessions.map((s) => shortId(s.sessionId)), cwds: [...new Set(res.sessions.map((s) => s.cwd))], hasCursor: Boolean(res.nextCursor) })
        if (!res.nextCursor) break
        cursor = res.nextCursor
      }
      return pages
    }

    evidence.listA = await listAll(workspaceA)
    evidence.listB = await listAll(workspaceB)
    evidence.listEmpty = await listAll(emptyDir)
    evidence.pageSize = pageSize || 'default(100)'
    evidence.pagination = { observedPages: evidence.listA.length, multiPage: evidence.listA.length > 1 }
    evidence.listBracketed = (await ctx.request('session/list', { cwd: workspaceA })).sessions.map((s) => shortId(s.sessionId))
  })
} catch (error) {
  evidence.error = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
} finally {
  child.stdin.end()
  await new Promise((resolve) => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); resolve() }, 8000)
    child.once('exit', () => { clearTimeout(timer); resolve() })
  })
}

evidence.closed = { exitCode: child.exitCode, signal: child.signalCode, hasStderr: stderr().trim().length > 0 }
evidence.created = { a: created.a.map(shortId), b: created.b.map(shortId) }
console.log(JSON.stringify(evidence, null, 2))
