/**
 * Temporary phase-2 diagnostic: locate the failing runtime phase without
 * printing credentials or conversation content.
 */
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { DeepSeekHarness } from '@deepseek-ai/dsh-sdk-client'

const root = await mkdtemp(join(tmpdir(), 'temporal-diag-'))
const dshHome = join(root, 'dsh-home')
const workspace = root
const provider = 'deepseek-official'
const model = 'deepseek-v4-flash'
const hasKey = Boolean(process.env.DEEPSEEK_API_KEY)
const token = `diag-${randomUUID().slice(0, 8)}`
const out = { hasKey, workspace, dshHome }

function makeHarness() {
  return new DeepSeekHarness({ profile: 'sdk', cwd: workspace, processCwd: workspace, dshHome, provider, model, initializeTimeoutMs: 60_000 })
}

async function step(name, fn) {
  try {
    const value = await fn()
    out[name] = { ok: true, detail: value }
  } catch (error) {
    out[name] = { ok: false, name: error?.name, message: String(error?.message ?? error).slice(0, 200) }
  }
}

let sessionId
const summarize = (notifications, events) => ({
  methods: [...new Set(notifications.map((n) => n.method))],
  eventTypes: [...new Set(events.map((e) => e?.type))],
  errorEvents: events.filter((e) => typeof e?.type === 'string' && e.type.includes('error')).map((e) => ({ type: e.type, keys: Object.keys(e) })),
  assistantEvents: events.filter((e) => e?.type === 'assistant/message').length
})

await step('process1', async () => {
  const h = makeHarness()
  try {
    await h.start()
    const handle = h.session()
    sessionId = handle.id
    const r1 = await handle.run(`Remember this token: ${token}. Reply with one short sentence.`)
    const r2 = await handle.run('What token did I ask you to remember? Reply with only that token.')
    return {
      sessionIdLength: handle.id.length,
      r1Chars: r1.finalResponse.length,
      r2HasToken: r2.finalResponse.includes(token),
      r1: summarize(r1.notifications, r1.events),
      r2: summarize(r2.notifications, r2.events)
    }
  } finally {
    await h.close().catch(() => {})
  }
})

if (hasKey && sessionId) {
  await step('process2-resume', async () => {
    const h = makeHarness()
    try {
      await h.start()
      const handle = h.session(sessionId)
      const r = await handle.run('What token did I ask you to remember before restart? Reply with only that token.')
      return { rHasToken: r.finalResponse.includes(token), chars: r.finalResponse.length }
    } finally {
      await h.close().catch(() => {})
    }
  })
}

console.log(JSON.stringify(out, null, 2))
