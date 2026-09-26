/**
 * Phase B acceptance probe: the verification executor obeys the session
 * permission boundary. Workspaces and outside directories are isolated temp
 * directories with random markers; real user files are never touched.
 *
 * Every denial must be recorded with its real reason, must never be reported
 * as passed, and must never silently escalate to a more permissive preset.
 * At least one case is driven through a real Loop Spec `Run:` path via the
 * real LoopController, not only through a direct helper call.
 *
 * Run under Electron's Node:
 *   $env:ELECTRON_RUN_AS_NODE=1
 *   .\node_modules\electron\dist\electron.exe scripts/probes/verify-permissions-impl.mjs
 */
import { createRequire } from 'node:module'
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, symlink } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, '..', '..')
const require = createRequire(import.meta.url)
const esbuild = require(join(repoRoot, 'node_modules/.pnpm/esbuild@0.25.12/node_modules/esbuild/lib/main.js'))

async function bundle(entry, outfile) {
  await esbuild.build({ entryPoints: [join(repoRoot, entry)], bundle: true, platform: 'node', format: 'cjs', outfile, external: [], logLevel: 'silent' })
  return require(outfile)
}

const { LoopController, DEFAULT_LOOP_BUDGET } = await bundle('src/main/loop/LoopController.ts', join(here, '.cache-perm-loop.cjs'))
const { EvidenceCollector } = await bundle('src/main/evidence/EvidenceCollector.ts', join(here, '.cache-perm-evidence.cjs'))
const { VerificationExecutor } = await bundle('src/main/evidence/VerificationExecutor.ts', join(here, '.cache-perm-verify.cjs'))

const checks = {}
const check = (name, value) => { checks[name] = Boolean(value) }
const executor = new VerificationExecutor()
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** Snapshot every relative path + content in a directory tree. */
async function tree(root) {
  const out = new Map()
  const walk = async (dir, prefix) => {
    for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
      const full = join(dir, entry.name)
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name
      if (entry.isDirectory()) await walk(full, rel)
      else out.set(rel, await readFile(full).catch(() => null))
    }
  }
  await walk(root, '')
  return out
}
const treeEquals = (a, b) => a.size === b.size && [...a].every(([k, v]) => b.get(k)?.equals(v))

const outsideRoot = await mkdtemp(join(tmpdir(), 'temporal-perm-outside-'))
const OUTSIDE_MARKER = 'outside-marker.txt'
await writeFile(join(outsideRoot, OUTSIDE_MARKER), 'untouched')

// ===========================================================================
// 1+2. Real Loop Spec path, read-only session: built-in content check works,
//      the Spec's Run: write attempt is denied and nothing is written.
// ===========================================================================
{
  const ws = await mkdtemp(join(tmpdir(), 'temporal-perm-ro-'))
  await writeFile(join(ws, 'marker.txt'), 'hello\n')
  const before = await tree(ws)
  const spec = [
    'Create a file named marker.txt whose contents are exactly: hello',
    'Run: echo overwritten > marker.txt'
  ].join('\n')
  // The "model" does nothing at all: any change must come from verification,
  // which is exactly what must NOT execute under read-only.
  const runtime = { prompt: async () => ({ text: 'read-only session; I cannot write.' }) }
  const controller = new LoopController(runtime, new EvidenceCollector(), { ...DEFAULT_LOOP_BUDGET, maxContinuations: 2, maxNoProgress: 2 }, Date.now, executor.run)
  const result = await controller.run({ rootSpec: spec, workspacePath: ws, permission: 'read-only', takeEvents: () => [] })

  check('readonly_builtin_content_check_passes', result.evidence.verification.some(
    (run) => run.method === 'builtin' && run.outcome === 'passed' && run.facts.some((f) => f.kind === 'content-equals' && f.matched && f.target === 'marker.txt')
  ))
  const denied = result.evidence.verification.filter((run) => run.outcome === 'denied')
  check('readonly_run_write_denied', denied.length > 0 && denied.every((run) => (run.denial ?? '').includes('read-only')))
  check('readonly_workspace_untouched', treeEquals(before, await tree(ws)))
  check('readonly_marker_content_intact', (await readFile(join(ws, 'marker.txt'), 'utf8')).includes('hello'))
  check('readonly_not_completed', result.terminal.status !== 'completed')
  const document = await bundle('src/main/result/ResultBuilder.ts', join(here, '.cache-perm-result.cjs'))
  const resultDoc = new document.ResultBuilder().build({
    finalResponse: result.finalResponse, evidence: result.evidence, outcome: 'failed',
    loopTerminal: result.terminal, decision: result.decision
  })
  check('readonly_denial_actionable', resultDoc.remaining.some((line) => line.includes('denied')))
}

// ===========================================================================
// Direct executor checks (3–7): each denial leaves the tree byte-identical.
// ===========================================================================
{
  // 3. read-only: delete / rename of an existing file.
  const ws = await mkdtemp(join(tmpdir(), 'temporal-perm-del-'))
  await writeFile(join(ws, 'keepme.txt'), 'keep')
  const before = await tree(ws)
  const del = await executor.run({
    label: 'delete attempt', method: { kind: 'shell', command: 'cmd', args: ['/c', 'del keepme.txt'] },
    cwd: ws, scope: 'workspace', targets: [], turn: 1,
    permission: { preset: 'read-only', workspacePath: ws }
  })
  const ren = await executor.run({
    label: 'rename attempt', method: { kind: 'shell', command: 'cmd', args: ['/c', 'ren keepme.txt other.txt'] },
    cwd: ws, scope: 'workspace', targets: [], turn: 1,
    permission: { preset: 'read-only', workspacePath: ws }
  })
  check('readonly_delete_denied', del.outcome === 'denied' && ren.outcome === 'denied')
  check('readonly_delete_rename_tree_intact', treeEquals(before, await tree(ws)))
}

{
  // 4. read-only: a script that would spawn a writing subprocess.
  const ws = await mkdtemp(join(tmpdir(), 'temporal-perm-sub-'))
  const before = await tree(ws)
  const run = await executor.run({
    label: 'subprocess write attempt',
    method: { kind: 'shell', command: 'cmd', args: ['/c', 'start /b cmd /c echo x > spawned.txt'] },
    cwd: ws, scope: 'workspace', targets: [], turn: 1,
    permission: { preset: 'read-only', workspacePath: ws }
  })
  check('readonly_subprocess_denied_before_spawn', run.outcome === 'denied')
  check('readonly_subprocess_tree_intact', treeEquals(before, await tree(ws)))
}

{
  // 5. workspace-write: absolute path and ../ escape to the outside marker.
  const ws = await mkdtemp(join(tmpdir(), 'temporal-perm-ws-'))
  const outsideBefore = await tree(outsideRoot)
  const abs = await executor.run({
    label: 'absolute outside write',
    method: { kind: 'shell', command: 'cmd', args: ['/c', `echo hacked > "${join(outsideRoot, OUTSIDE_MARKER)}"`] },
    cwd: ws, scope: 'workspace', targets: [], turn: 1,
    permission: { preset: 'workspace-write', workspacePath: ws }
  })
  const rel = await executor.run({
    label: 'relative outside write',
    method: { kind: 'shell', command: 'cmd', args: ['/c', `echo hacked > "${join('..', outsideRoot.substring(outsideRoot.lastIndexOf('\\') + 1), OUTSIDE_MARKER)}"`] },
    cwd: ws, scope: 'workspace', targets: [], turn: 1,
    permission: { preset: 'workspace-write', workspacePath: ws }
  })
  check('workspace_write_outside_denied', abs.outcome === 'denied' && rel.outcome === 'denied')
  check('workspace_write_outside_marker_intact', treeEquals(outsideBefore, await tree(outsideRoot)))
}

{
  // 6. workspace-write: junction inside the workspace pointing outside.
  const ws = await mkdtemp(join(tmpdir(), 'temporal-perm-junc-'))
  const outsideBefore = await tree(outsideRoot)
  await symlink(outsideRoot, join(ws, 'leak'), 'junction')
  const shell = await executor.run({
    label: 'junction write via shell',
    method: { kind: 'shell', command: 'cmd', args: ['/c', `echo hacked > leak\\${OUTSIDE_MARKER}`] },
    cwd: ws, scope: 'workspace', targets: [], turn: 1,
    permission: { preset: 'workspace-write', workspacePath: ws }
  })
  // The built-in read-only check must also refuse to follow the junction out.
  const builtin = await executor.run({
    label: 'junction read via builtin',
    method: { kind: 'file-exists', target: `leak/${OUTSIDE_MARKER}` },
    cwd: ws, scope: 'file', targets: [`leak/${OUTSIDE_MARKER}`], turn: 1,
    permission: { preset: 'workspace-write', workspacePath: ws }
  })
  check('junction_shell_denied', shell.outcome === 'denied')
  check('junction_builtin_refused', builtin.outcome === 'denied' && (builtin.denial ?? '').includes('escapes the workspace'))
  check('junction_outside_marker_intact', treeEquals(outsideBefore, await tree(outsideRoot)))
}

{
  // 7. Missing preset: fail closed for shell AND built-in checks.
  const ws = await mkdtemp(join(tmpdir(), 'temporal-perm-nopreset-'))
  const shell = await executor.run({
    label: 'no preset shell', method: { kind: 'shell', command: 'cmd', args: ['/c', 'echo x > x.txt'] },
    cwd: ws, scope: 'workspace', targets: [], turn: 1, permission: undefined
  })
  const builtin = await executor.run({
    label: 'no preset builtin', method: { kind: 'file-exists', target: 'x.txt' },
    cwd: ws, scope: 'file', targets: ['x.txt'], turn: 1, permission: undefined
  })
  check('missing_preset_fail_closed', shell.outcome === 'denied' && builtin.outcome === 'denied')
  check('missing_preset_reason_recorded', (shell.denial ?? '').includes('fail closed') && !existsSync(join(ws, 'x.txt')))
}

{
  // 8. Full-access (explicit user opt-in): timeout terminates the whole
  //    process tree. The outer batch spawns a nested cmd that sleeps ~6s and
  //    then writes the marker itself — if the tree is not fully terminated,
  //    the orphaned grandchild completes the write.
  const ws = await mkdtemp(join(tmpdir(), 'temporal-perm-timeout-'))
  const marker = join(ws, 'late-marker.txt')
  await writeFile(join(ws, 'run-slow.cmd'), '@echo off\r\ncmd /c slowchild.cmd\r\n')
  await writeFile(join(ws, 'slowchild.cmd'), '@echo off\r\nping -n 6 127.0.0.1 > nul\r\necho late > late-marker.txt\r\n')
  const run = await executor.run({
    label: 'timeout tree kill',
    method: { kind: 'shell', command: 'cmd', args: ['/c', 'run-slow.cmd'] },
    cwd: ws, scope: 'workspace', targets: [], turn: 1, timeoutMs: 1000,
    permission: { preset: 'danger-full-access', workspacePath: ws }
  })
  check('timeout_recorded', run.signal === 'timeout')
  await wait(8000)
  check('timeout_tree_killed_no_late_write', !existsSync(marker))
  check('timeout_not_passed', run.outcome !== 'passed')
}

{
  // Built-in content check stays fully functional under full-access too, and
  // a workspace-write builtin check on an escaping `..` target is refused.
  const ws = await mkdtemp(join(tmpdir(), 'temporal-perm-builtin-'))
  await writeFile(join(ws, 'note.txt'), 'data')
  const ok = await executor.run({
    label: 'builtin content', method: { kind: 'content-equals', target: 'note.txt', expected: 'data' },
    cwd: ws, scope: 'file', targets: ['note.txt'], turn: 1,
    permission: { preset: 'workspace-write', workspacePath: ws }
  })
  const escape = await executor.run({
    label: 'builtin escape', method: { kind: 'file-exists', target: `../${outsideRoot.substring(outsideRoot.lastIndexOf('\\') + 1)}/${OUTSIDE_MARKER}` },
    cwd: ws, scope: 'file', targets: ['../outside-marker.txt'], turn: 1,
    permission: { preset: 'workspace-write', workspacePath: ws }
  })
  check('builtin_content_works', ok.outcome === 'passed' && ok.facts[0].matched)
  check('builtin_escape_refused', escape.outcome === 'denied')
  check('builtin_no_shell_for_builtin', ok.exitCode === null)
}

const passed = Object.values(checks).every(Boolean)
console.log(JSON.stringify({ checks, passed }, null, 2))
if (!passed) process.exitCode = 1
