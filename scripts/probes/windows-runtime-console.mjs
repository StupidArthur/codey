/** Real Win32/DSH ACL probe for the Electron GUI runtime host. No model/key.
 * Checks hidden console attachment, unchanged argv, bidirectional ACP-style
 * pipes, in-workspace writes and denied out-of-workspace writes. */
import { createRequire } from 'node:module'
import { spawn } from 'node:child_process'
import { mkdtemp, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

if (process.platform !== 'win32') { console.log(JSON.stringify({ status: 'skipped' })); process.exit(2) }
const require = createRequire(import.meta.url)
const root = process.cwd()
const store = join(root, 'node_modules', '.pnpm')
const aclDir = (await readdir(store)).find(name => name.startsWith('@deepseek-ai+dsh-sandbox-wi'))
const aclUrl = pathToFileURL(join(store, aclDir, 'node_modules', '@deepseek-ai', 'dsh-sandbox-windows-acl', 'lib', 'index.js')).href
const esbuild = require(join(store, 'esbuild@0.25.12', 'node_modules', 'esbuild'))
const temp = await mkdtemp(join(tmpdir(), 'temporal-host-probe-'))
const bundle = join(temp, 'host-source.cjs')
await esbuild.build({ entryPoints: ['src/main/dsh/WindowsRuntimeHost.ts'], bundle: true, platform: 'node', format: 'cjs', outfile: bundle })
const { windowsConsolePreloadSource } = require(bundle)
const payload = join(temp, 'payload.mjs')
await writeFile(payload, `
import {mkdtemp,mkdir,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os'; import {join} from 'node:path';
import {createRequire} from 'node:module';
import {spawn} from 'node:child_process';
import {AclSandbox,workspaceWriteSid,tempWriteSid} from ${JSON.stringify(aclUrl)};
const root=await mkdtemp(join(tmpdir(),'temporal-host-acl-'));
const ws=join(root,'workspace'),temp=join(root,'private');await mkdir(ws);await mkdir(temp);
const sandbox=new AclSandbox({writableDirs:[ws],tempDir:temp,writeSid:workspaceWriteSid(ws),tempWriteSid:tempWriteSid(temp),mode:'workspace-write'});
const checks={argv_preserved:process.argv[2]==='--host-check'};
try {
 await sandbox.init();
 const run=async command=>await sandbox.spawn({command:'C:\\\\Windows\\\\System32\\\\cmd.exe',args:['/c',command],cwd:ws}).wait();
 const echo=await run('echo SANDBOX_OK');checks.sandbox_process_exit_zero=echo.exitCode===0;checks.sandbox_output_observed=String(echo.stdout).includes('SANDBOX_OK');
 const write=await run('echo allowed > allowed.txt');checks.workspace_write_allowed=write.exitCode===0&&(await readFile(join(ws,'allowed.txt'),'utf8')).trim()==='allowed';
 const outside=join(root,'outside.txt');const denied=await run('echo forbidden > "'+outside+'"');
 checks.outside_write_denied=denied.exitCode!==0;checks.outside_file_absent=await readFile(outside).then(()=>false,()=>true);
 const runner=${JSON.stringify(aclUrl.replace(/index\.js$/, 'runner.js'))};
 const runnerPath=(await import('node:url')).fileURLToPath(runner);
 const child=spawn(process.execPath,[runnerPath,'--workspace',ws,'--temp',temp,'--mode','workspace-write','--','C:\\\\Windows\\\\System32\\\\cmd.exe','/c','echo RUNNER_OK'],{windowsHide:true,stdio:['pipe','pipe','pipe']});
 child.stdin.end();let runnerOut='';child.stdout.on('data',b=>runnerOut+=b);child.stderr.on('data',()=>{});
 const runnerExit=await new Promise(resolve=>child.on('close',resolve));
 checks.gui_runner_chain_works=runnerExit===0&&runnerOut.includes('RUNNER_OK');
 const k=createRequire(${JSON.stringify(require.resolve('koffi'))})(${JSON.stringify(require.resolve('koffi'))});
 const get=k.load('kernel32.dll').func('void * __stdcall GetConsoleWindow()');
 checks.console_attached=Boolean(get());checks.console_hidden=!k.load('user32.dll').func('bool __stdcall IsWindowVisible(void *)')(get());
 let input='';for await(const chunk of process.stdin)input+=chunk;checks.input_pipe_preserved=input.trim()==='ACP_PIPE_OK';
} finally {sandbox.dispose()}
console.log(JSON.stringify({checks,passed:Object.values(checks).every(Boolean)}));
`)
const entry = join(temp, 'runtime-host.cjs')
await writeFile(entry, windowsConsolePreloadSource(require.resolve('koffi')))
const child = spawn(join(root, 'node_modules', 'electron', 'dist', 'electron.exe'), [payload, '--host-check'], {
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --require ${JSON.stringify(entry.replace(/\\/g, '/'))}`.trim() }, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe']
})
child.stdin.end('ACP_PIPE_OK\n')
let output = '', errors = ''
child.stdout.on('data', chunk => { output += chunk })
child.stderr.on('data', chunk => { errors += chunk })
const deadline = setTimeout(() => child.kill(), 30000)
const exit = await new Promise(resolve => { child.on('error', () => resolve(1)); child.on('close', resolve) })
clearTimeout(deadline)
let report
try { report = JSON.parse(output.trim()) } catch { report = { passed: false, hasStderr: Boolean(errors), exit } }
console.log(JSON.stringify(report, null, 2))
process.exitCode = exit === 0 && report.passed ? 0 : 1
