/**
 * Phase-1 acceptance probe for the real SessionDiscovery implementation.
 *
 * It bundles the TypeScript module with the repo's esbuild, seeds persisted ACP
 * sessions, then calls `SessionDiscovery.listByWorkspace` against two
 * workspaces and an empty directory. Prints only counts/ids (truncated).
 *
 *   node scripts/probes/dsh-session-discovery-impl.mjs
 */
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Readable, Writable } from 'node:stream'
import { client, ndJsonStream, PROTOCOL_VERSION } from '@agentclientprotocol/sdk'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, '..', '..')
const require = createRequire(import.meta.url)
const esbuild = require(join(repoRoot, 'node_modules/.pnpm/esbuild@0.25.12/node_modules/esbuild/lib/main.js'))
const dshBin = join(require.resolve('@deepseek-ai/dsh/package.json'), '..', 'lib', 'bin.js')

const root = await mkdtemp(join(tmpdir(), 'temporal-discovery-impl-'))
const dshHome = join(root, 'dsh-home')
const workspaceA = join(root, 'workspace-a')
const workspaceB = join(root, 'workspace-b')
const emptyDir = join(root, 'empty')
await Promise.all([mkdir(workspaceA, { recursive: true }), mkdir(workspaceB, { recursive: true }), mkdir(emptyDir, { recursive: true })])

process.env.DSH_HOME = dshHome
const evidence = { dshHome, workspaces: { workspaceA, workspaceB, emptyDir } }

// --- seed persisted sessions through the public ACP surface ---
function spawnAcp() {
  const child = spawn(process.execPath, [dshBin, '--profile', 'acp'], {
    cwd: root,
    env: { ...process.env, DSH_HOME: dshHome },
    stdio: ['pipe', 'pipe', 'pipe']
  })
  child.stderr.on('data', () => {})
  return child
}
async function seed(cwd, count) {
  const child = spawnAcp()
  const ids = []
  try {
    await client({ name: 'seed' }).connectWith(
      ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout)),
      async (ctx) => {
        await ctx.request('initialize', { protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
        for (let i = 0; i < count; i += 1) {
          const res = await ctx.request('session/new', { cwd, mcpServers: [] })
          ids.push(res.sessionId)
        }
        for (const sessionId of ids) await ctx.request('session/close', { sessionId })
      }
    )
  } finally {
    child.stdin.end()
    await new Promise((resolve) => { const t = setTimeout(() => { child.kill('SIGKILL'); resolve() }, 8000); child.once('exit', () => { clearTimeout(t); resolve() }) })
  }
  return ids
}
const seededA = await seed(workspaceA, 3)
const seededB = await seed(workspaceB, 2)

// --- bundle and exercise the real implementation ---
const bundlePath = join(here, '.cache-session-discovery.cjs')
await esbuild.build({
  entryPoints: [join(repoRoot, 'src/main/dsh/SessionDiscovery.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile: bundlePath,
  external: ['@agentclientprotocol/sdk'],
  logLevel: 'silent'
})
const { SessionDiscovery, resolveInstalledDshBin } = require(bundlePath)
evidence.resolvedDshBinMatches = resolveInstalledDshBin() === dshBin

const discovery = new SessionDiscovery({ listTimeoutMs: 60_000 })
const listA = await discovery.listByWorkspace(workspaceA)
const listB = await discovery.listByWorkspace(workspaceB)
const listEmpty = await discovery.listByWorkspace(emptyDir)
const listAagain = await discovery.listByWorkspace(workspaceA)
evidence.implementation = {
  seeded: { a: seededA.length, b: seededB.length },
  listA: { count: listA.length, unique: new Set(listA.map((s) => s.id)).size, cwds: [...new Set(listA.map((s) => s.workspacePath))] },
  listB: { count: listB.length, unique: new Set(listB.map((s) => s.id)).size },
  listEmpty: listEmpty.length,
  repeatStable: listAagain.length === listA.length && listAagain.every((s) => listA.some((x) => x.id === s.id)),
  isolation: listA.every((s) => seededA.includes(s.id)) && listB.every((s) => seededB.includes(s.id)),
  allSeededVisible: seededA.every((id) => listA.some((s) => s.id === id)) && seededB.every((id) => listB.some((s) => s.id === id))
}

// --- error path: discovery must reject with a real error on a bad bin ---
try {
  const broken = new SessionDiscovery({ dshBin: join(root, 'does-not-exist.js'), initializeTimeoutMs: 5_000, listTimeoutMs: 8_000 })
  await broken.listByWorkspace(workspaceA)
  evidence.errorPath = { threw: false }
} catch (error) {
  evidence.errorPath = { threw: true, name: error?.name, message: String(error?.message ?? error).slice(0, 180) }
}

console.log(JSON.stringify(evidence, null, 2))
