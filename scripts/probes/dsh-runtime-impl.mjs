/**
 * Phase-A acceptance probe for the real DshRuntime (ACP execution path).
 *
 *   DEEPSEEK_API_KEY=... node scripts/probes/dsh-runtime-impl.mjs
 *
 * One Node host process creates two DshRuntime instances in sequence; each
 * starts its own `dsh --profile acp` subprocess against the same DSH home.
 * Prints only booleans, counts, session-id length and event kinds.
 */
import { createRequire } from 'node:module'
import { mkdtemp, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, '..', '..')
const require = createRequire(import.meta.url)
const esbuild = require(join(repoRoot, 'node_modules/.pnpm/esbuild@0.25.12/node_modules/esbuild/lib/main.js'))

const root = await mkdtemp(join(tmpdir(), 'temporal-runtime-impl-'))
const dshHome = join(root, 'dsh-home')
const workspace = join(root, 'workspace')
await mkdir(workspace, { recursive: true })
process.env.DSH_HOME = dshHome

const bundlePath = join(here, '.cache-dsh-runtime.cjs')
await esbuild.build({
  entryPoints: [join(repoRoot, 'src/main/dsh/DshRuntime.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile: bundlePath,
  external: ['@agentclientprotocol/sdk'],
  logLevel: 'silent'
})
const { DshRuntime } = require(bundlePath)

const hasKey = Boolean(process.env.DEEPSEEK_API_KEY)
const token = `impl-${randomUUID().slice(0, 8)}`
const evidence = { hasKey }
if (!hasKey) {
  console.log(JSON.stringify({ ...evidence, status: 'skipped', reason: 'DEEPSEEK_API_KEY absent' }, null, 2))
  process.exitCode = 2
} else {
  const settings = { provider: 'deepseek-official', model: 'deepseek-v4-flash' }
  const kindsFor = (events) => [...new Set(events.map((e) => e.kind))]
  let sessionId

  const firstEvents = []
  const first = new DshRuntime({ workspacePath: workspace, settings, credential: process.env.DEEPSEEK_API_KEY, onEvent: (e) => firstEvents.push(e) })
  try {
    const started = await first.start()
    sessionId = started.sessionId
    const r1 = await first.prompt(`Remember this token for later: ${token}. Reply with one short sentence.`)
    const r2 = await first.prompt('What token did I ask you to remember? Reply with only that token.')
    evidence.newSession = { idLength: sessionId.length, r1Chars: r1.text.length, r2HasToken: r2.text.includes(token), eventKinds: kindsFor(firstEvents), eventCount: firstEvents.length }
  } finally {
    await first.close()
  }

  const secondEvents = []
  const second = new DshRuntime({ workspacePath: workspace, settings, credential: process.env.DEEPSEEK_API_KEY, onEvent: (e) => secondEvents.push(e) })
  try {
    const started = await second.start(sessionId)
    const r3 = await second.prompt('What token did I ask you to remember before restart? Reply with only that token.')
    evidence.resume = { sameId: started.sessionId === sessionId, r3HasToken: r3.text.includes(token), r3Chars: r3.text.length, eventKinds: kindsFor(secondEvents) }
  } finally {
    await second.close()
  }

  evidence.passed = Boolean(evidence.newSession?.r2HasToken && evidence.resume?.r3HasToken && evidence.resume?.sameId)
  console.log(JSON.stringify(evidence, null, 2))
  if (!evidence.passed) process.exitCode = 1
}
