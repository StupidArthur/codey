/**
 * Phase-2 diagnostic probe: locate the failing runtime phase. Like the P0
 * probe, one Node host process starts two `dsh --profile sdk` runtime
 * subprocesses in sequence against the same temporary DSH home.
 *
 * Prints only phase status, event kinds/counts and JSON-RPC error fields.
 * Error text is redacted for credential-like environment values and the
 * probe's own memory token, then flattened and truncated. The probe never
 * prints prompts or model responses.
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
const out = { hasKey, hostProcess: process.pid, workspace, dshHome }

/** Values that must never appear even inside a truncated error message. */
const secrets = [...new Set([
  token,
  ...Object.entries(process.env)
    .filter(([key, value]) => typeof value === 'string' && value.length >= 8 && /(API_?KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/i.test(key))
    .map(([, value]) => value)
])].filter((value) => value.length > 0)

function makeHarness() {
  return new DeepSeekHarness({ profile: 'sdk', cwd: workspace, processCwd: workspace, dshHome, provider, model, initializeTimeoutMs: 60_000 })
}

function sanitize(text) {
  let out = String(text)
  for (const secret of secrets) out = out.split(secret).join('[redacted]')
  return out.replace(/[\r\n]+/g, ' ').slice(0, 200)
}

function describeError(error) {
  const described = { name: typeof error?.name === 'string' && error.name ? error.name : 'Error' }
  if (typeof error?.code === 'number') described.code = error.code
  if (typeof error?.message === 'string') described.message = sanitize(error.message)
  return described
}

async function step(name, fn) {
  try {
    const value = await fn()
    out[name] = value === undefined ? { ok: true } : { ok: true, detail: value }
  } catch (error) {
    out[name] = { ok: false, ...describeError(error) }
  }
}

const summarize = (notifications, events) => ({
  methods: [...new Set(notifications.map((n) => n.method))],
  eventTypes: [...new Set(events.map((e) => e?.type))],
  errorEvents: events.filter((e) => typeof e?.type === 'string' && e.type.includes('error')).map((e) => ({ type: e.type, keys: Object.keys(e) })),
  assistantEvents: events.filter((e) => e?.type === 'assistant/message').length
})

let h1
let h2
let sessionId

await step('subprocess1', async () => {
  h1 = makeHarness()
  await h1.start()
  const handle = h1.session()
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
})
if (h1) await step('subprocess1-close', () => h1.close())

if (hasKey && sessionId) {
  await step('subprocess2-resume', async () => {
    h2 = makeHarness()
    await h2.start()
    const handle = h2.session(sessionId)
    const r = await handle.run('What token did I ask you to remember before restart? Reply with only that token.')
    return { rHasToken: r.finalResponse.includes(token), chars: r.finalResponse.length }
  })
  if (h2) await step('subprocess2-close', () => h2.close())
}

console.log(JSON.stringify(out, null, 2))
if (Object.values(out).some((value) => value && typeof value === 'object' && value.ok === false)) process.exitCode = 1
