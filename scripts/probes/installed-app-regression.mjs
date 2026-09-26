/** Launch the installed app with an isolated DSH home, run its five existing
 * real-model regression scenarios, then gracefully close only this app. */
import { spawn, spawnSync } from 'node:child_process'
import { mkdtemp, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { readdir } from 'node:fs/promises'

const root = await mkdtemp(join(tmpdir(), 'temporal-final-regression-'))
const home = join(root, 'dsh-home')
await mkdir(home)
const port = process.env.TEMPORAL_CDP_PORT ?? '9227'
const exe = process.env.TEMPORAL_APP_EXE ?? join(process.env.LOCALAPPDATA, 'Programs', 'Temporal Workspace', 'Temporal Workspace.exe')
const env = { ...process.env, DSH_HOME: home, TEMPORAL_CDP_PORT: port }
delete env.ELECTRON_RUN_AS_NODE
const app = spawn(exe, [`--remote-debugging-port=${port}`], { env, stdio: 'ignore', windowsHide: true })
let launchError
app.on('error', error => { launchError = error })
let exitCode = 1
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
try {
  let ready = false
  for (let n = 0; n < 60 && !ready; n++) {
    if (launchError) throw launchError
    ready = await fetch(`http://127.0.0.1:${port}/json/list`).then(r => r.json()).then(list => list.some(t => t.type === 'page')).catch(() => false)
    if (!ready) await sleep(1000)
  }
  if (!ready) throw new Error('installed app did not expose its renderer')
  exitCode = await new Promise(resolve => {
    const probe = spawn(process.execPath, ['scripts/probes/installed-app-e2e.mjs'], { env, stdio: 'inherit', windowsHide: true })
    probe.on('error', () => resolve(1))
    probe.on('close', code => resolve(code ?? 1))
  })
} catch (error) {
  console.log(JSON.stringify({ passed: false, stage: 'regression-launch', errorName: error?.name ?? 'Error' }))
} finally {
  try {
    const page = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(t => t.type === 'page')
    const store = join(process.cwd(), 'node_modules', '.pnpm')
    const wsDir = (await readdir(store)).find(name => /^ws@/.test(name))
    const WebSocket = createRequire(import.meta.url)(join(store, wsDir, 'node_modules', 'ws'))
    const socket = new WebSocket(page.webSocketDebuggerUrl)
    await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject) })
    socket.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: 'window.close()' } }))
    await Promise.race([new Promise(resolve => app.once('exit', resolve)), sleep(15000)])
    socket.close()
  } catch { /* Fall back to reclaiming only the app started by this probe. */ }
  if (app.pid && app.exitCode === null) spawnSync('taskkill', ['/PID', String(app.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', timeout: 10000 })
}
process.exitCode = exitCode
