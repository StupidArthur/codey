/**
 * Permission-enforcement probe for the real DshRuntime with a real model.
 *
 *   TEMPORAL_TEST_API_KEY=... TEMPORAL_TEST_BASE_URL=... \
 *   TEMPORAL_TEST_PROVIDER=volc-ark TEMPORAL_TEST_MODEL=deepseek-v4-flash \
 *   node scripts/probes/dsh-permission-impl.mjs
 *
 * Asks the model to write a file under two presets against fresh workspaces:
 * `read-only` must leave the file absent (the client may not escalate it),
 * `workspace-write` must create it. Prints only booleans, counts and kinds.
 */
import { createRequire } from 'node:module'
import { mkdtemp, mkdir, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, '..', '..')
const require = createRequire(import.meta.url)
const esbuild = require(join(repoRoot, 'node_modules/.pnpm/esbuild@0.25.12/node_modules/esbuild/lib/main.js'))

const provider = process.env.TEMPORAL_TEST_PROVIDER ?? 'deepseek-official'
const model = process.env.TEMPORAL_TEST_MODEL ?? 'deepseek-v4-flash'
const baseUrl = process.env.TEMPORAL_TEST_BASE_URL
const credential = provider === 'deepseek-official' ? process.env.DEEPSEEK_API_KEY : (process.env.TEMPORAL_TEST_API_KEY ?? process.env.DEEPSEEK_API_KEY)
const evidence = { provider, model, hasBaseUrl: Boolean(baseUrl), hasCredential: Boolean(credential) }

if (!credential) {
  console.log(JSON.stringify({ ...evidence, status: 'skipped', reason: 'credential absent' }, null, 2))
  process.exit(2)
}

const root = await mkdtemp(join(tmpdir(), 'temporal-permission-impl-'))
process.env.DSH_HOME = join(root, 'dsh-home')
await mkdir(process.env.DSH_HOME, { recursive: true })

const bundlePath = join(here, '.cache-permission-runtime.cjs')
await esbuild.build({
  entryPoints: [join(repoRoot, 'src/main/dsh/DshRuntime.ts')],
  bundle: true, platform: 'node', format: 'cjs', outfile: bundlePath,
  external: ['@agentclientprotocol/sdk'], logLevel: 'silent'
})
const { DshRuntime } = require(bundlePath)

const settings = { provider, model, ...(baseUrl ? { baseUrl } : {}) }

async function attempt(preset) {
  const workspace = join(root, `workspace-${preset}`)
  await mkdir(workspace, { recursive: true })
  const tag = `perm-${randomUUID().slice(0, 8)}`
  const events = []
  const runtime = new DshRuntime({
    workspacePath: workspace, settings, credential, permission: preset,
    onEvent: (event) => events.push(event)
  })
  let threw = false
  try {
    await runtime.start()
    await runtime.prompt(`Create a file named NOTES.md in the current workspace whose entire contents are exactly the single line: ${tag}. Do it now with your file-writing tool.`)
  } catch {
    threw = true
  } finally {
    await runtime.close()
  }
  let created = false
  try { created = (await stat(join(workspace, 'NOTES.md'))).isFile() } catch { created = false }
  return { preset, created, threw, eventKinds: [...new Set(events.map((event) => event.kind))].sort(), denied: events.some((event) => /read-only|denied|permission/i.test(event.message)) }
}

try {
  const readOnly = await attempt('read-only')
  const workspaceWrite = await attempt('workspace-write')
  evidence.readOnly = readOnly
  evidence.workspaceWrite = workspaceWrite
  evidence.passed = readOnly.created === false && workspaceWrite.created === true
} catch (error) {
  evidence.status = 'failed'
  evidence.failure = String(error?.message ?? error).replace(/\s+/g, ' ').slice(0, 240)
}

console.log(JSON.stringify(evidence, null, 2))
process.exitCode = evidence.passed ? 0 : 1
