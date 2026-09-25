/** Raw ACP handshake against a given DSH bin, printing full stderr. */
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const bin = process.argv[2]
const electron = process.argv[3] // optional electron.exe for ELECTRON_RUN_AS_NODE
const root = await mkdtemp(join(tmpdir(), 'dsh-raw-acp-'))
const workspace = join(root, 'ws')
const dshHome = join(root, 'home')
await mkdir(workspace, { recursive: true })
await mkdir(dshHome, { recursive: true })

const patch = [
  '- id: llm-pi-ai',
  '  config:',
  '    providers:',
  '      "volc-ark":',
  '        displayName: "volc-ark"',
  '        apiKeyEnv: TEMPORAL_LLM_API_KEY',
  '        api: openai-completions',
  '        baseURL: "https://ark.cn-beijing.volces.com/api/plan/v3"',
  '        models:',
  '          - id: "deepseek-v4-flash"',
  '            name: "deepseek-v4-flash"',
  '            contextWindow: 131072',
  '            maxTokens: 32768',
  '- id: acp',
  '  config:',
  '    provider: "volc-ark"',
  '    model: "deepseek-v4-flash"'
].join('\n') + '\n'
const patchPath = join(root, 'patch.yml')
await writeFile(patchPath, patch)

const env = { ...process.env, DSH_HOME: dshHome, TEMPORAL_LLM_API_KEY: process.env.TEMPORAL_TEST_API_KEY ?? 'x' }
const args = [bin, '--profile', 'acp', '--patch', patchPath]
let cmd, cmdArgs
if (electron) {
  env.ELECTRON_RUN_AS_NODE = '1'
  cmd = electron
  cmdArgs = args
} else {
  cmd = process.execPath
  cmdArgs = args
}

const child = spawn(cmd, cmdArgs, { cwd: workspace, env, stdio: ['pipe', 'pipe', 'pipe'] })
let stdout = ''
let stderr = ''
child.stdout.on('data', (d) => { stdout += d.toString() })
child.stderr.on('data', (d) => { stderr += d.toString() })

const send = (obj) => child.stdin.write(JSON.stringify(obj) + '\n')
send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'raw', version: '0' } } })
setTimeout(() => send({ jsonrpc: '2.0', id: 2, method: 'session/new', params: { cwd: workspace, mcpServers: [] } }), 1500)
setTimeout(() => { try { child.stdin.end() } catch {} }, 6000)

const code = await new Promise((resolve) => child.on('exit', (c) => resolve(c)))
setTimeout(() => {}, 0)
const lines = stderr.split('\n').filter((l) => l.trim()).slice(0, 40)
console.log(JSON.stringify({ exit: code, stdoutFirst: stdout.slice(0, 400), stderrLines: lines }, null, 2))
