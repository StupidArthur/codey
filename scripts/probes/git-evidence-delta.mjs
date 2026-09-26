/**
 * TODO 6 §1.2 acceptance probe: git evidence must not lose this round's
 * modifications. The real EvidenceCollector runs against isolated temp
 * workspaces (a real git repo and a non-git directory); nothing outside the
 * temp dirs is touched.
 *
 * Covered facts:
 *  - a clean file modified this turn registers in both round-so-far and turn
 *    deltas
 *  - a file that was already dirty BEFORE the round, modified again this
 *    turn, registers this turn's delta while keeping its pre-existing
 *    attribution
 *  - two continuations editing the same file each register their own delta
 *  - an untouched pre-existing dirty file is never claimed as this round's
 *    change
 *  - deletion, staged modification, untracked creation describe accurately
 *  - a content-identical rewrite (mtime-only touch) is not a change
 *
 * Run: node scripts/probes/git-evidence-delta.mjs
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createRequire } from 'node:module'
import { mkdtemp, rm, writeFile, unlink } from 'node:fs/promises'
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

const { EvidenceCollector } = await bundle('src/main/evidence/EvidenceCollector.ts', join(here, '.cache-gitev-evidence.cjs'))

const checks = {}
const check = (name, value) => { checks[name] = Boolean(value) }
const run = promisify(execFile)
const git = async (cwd, args) => run('git', ['-C', cwd, ...args], { windowsHide: true })
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const collector = new EvidenceCollector()

/** Verify a tracked file exists in the repo so later edits are real deltas. */
async function makeGitWorkspace() {
  const ws = await mkdtemp(join(tmpdir(), 'temporal-gitev-'))
  await git(ws, ['init'])
  await git(ws, ['config', 'user.email', 'probe@example.invalid'])
  await git(ws, ['config', 'user.name', 'probe'])
  await writeFile(join(ws, 'alpha.txt'), 'alpha-1\n')
  await writeFile(join(ws, 'beta.txt'), 'beta-1\n')
  await git(ws, ['add', '.'])
  await git(ws, ['commit', '-m', 'baseline'])
  return ws
}

{
  // 1-4: one git workspace, one turn in which alpha (clean) is modified,
  // gamma (dirty before the round) is modified again, beta (dirty before the
  // round) is untouched, and delta.txt is untracked-new.
  const ws = await makeGitWorkspace()
  try {
    await writeFile(join(ws, 'gamma.txt'), 'gamma-user-edit\n')
    await writeFile(join(ws, 'beta.txt'), 'beta-user-edit\n')
    const start = await collector.baseline(ws)
    check('baseline_records_preexisting', start.preexisting.has('gamma.txt') && start.preexisting.has('beta.txt'))

    await wait(30)
    await writeFile(join(ws, 'alpha.txt'), 'alpha-2 by agent\n')
    await writeFile(join(ws, 'gamma.txt'), 'gamma-user-edit + agent turn\n')
    await writeFile(join(ws, 'delta.txt'), 'new file\n')
    let prev = start
    let collected = await collector.collect(ws, start, prev, [], [], 'completed')
    let bundle = collected.bundle
    prev = collected.snapshot

    check('clean_file_modified_in_changed', bundle.changedFiles.includes('alpha.txt'))
    check('clean_file_modified_in_turn_delta', bundle.turnChangedFiles.includes('alpha.txt'))
    check('same_file_further_edit_in_changed', bundle.changedFiles.includes('gamma.txt'))
    check('same_file_further_edit_in_turn_delta', bundle.turnChangedFiles.includes('gamma.txt'))
    check('preexisting_attribution_kept', bundle.preexistingChanges.includes('gamma.txt'))
    check('untouched_preexisting_not_claimed', !bundle.changedFiles.includes('beta.txt') && !bundle.turnChangedFiles.includes('beta.txt'))
    check('untracked_new_file_listed', bundle.changedFiles.includes('delta.txt') && bundle.newFiles.includes('delta.txt'))

    const records = collector.toRecords(bundle)
    const detail = (file) => records.find((record) => record.kind === 'workspace' && record.label === file)?.detail
    check('detail_created', detail('delta.txt') === 'created')
    check('detail_modified', detail('alpha.txt') === 'modified')

    // 3 (continued): a second continuation edits gamma again — its delta must
    // register again instead of disappearing behind the first edit.
    await wait(30)
    await writeFile(join(ws, 'gamma.txt'), 'gamma-user-edit + agent turn 2\n')
    collected = await collector.collect(ws, start, prev, [], [], 'completed')
    check('second_continuation_delta_registered', collected.bundle.turnChangedFiles.includes('gamma.txt') && collected.bundle.changedFiles.includes('gamma.txt'))
    prev = collected.snapshot

    // 5: deletion of a tracked file.
    await wait(30)
    await unlink(join(ws, 'alpha.txt'))
    collected = await collector.collect(ws, start, prev, [], [], 'completed')
    check('deletion_in_changed', collected.bundle.changedFiles.includes('alpha.txt'))
    check('deletion_in_deleted_files', collected.bundle.deletedFiles.includes('alpha.txt'))
    const deletedDetail = collector.toRecords(collected.bundle).find((record) => record.kind === 'workspace' && record.label === 'alpha.txt')?.detail
    check('detail_deleted', deletedDetail === 'deleted')
    prev = collected.snapshot

    // 6: staged modification (edit + git add).
    await wait(30)
    await writeFile(join(ws, 'beta.txt'), 'beta staged by agent\n')
    await git(ws, ['add', 'beta.txt'])
    collected = await collector.collect(ws, start, prev, [], [], 'completed')
    check('staged_modification_in_changed', collected.bundle.changedFiles.includes('beta.txt'))
    const stagedDetail = collector.toRecords(collected.bundle).find((record) => record.kind === 'workspace' && record.label === 'beta.txt')?.detail
    check('detail_staged', stagedDetail === 'modified (staged)')
    prev = collected.snapshot

    // 8: content-identical rewrite (only mtime moves) is not a change.
    await wait(30)
    const content = await (await import('node:fs/promises')).readFile(join(ws, 'gamma.txt'), 'utf8')
    await writeFile(join(ws, 'gamma.txt'), content)
    const afterRewrite = await collector.collect(ws, start, prev, [], [], 'completed')
    check('same_content_rewrite_not_turn_delta', !afterRewrite.bundle.turnChangedFiles.includes('gamma.txt'))
  } finally {
    await rm(ws, { recursive: true, force: true })
  }
}

{
  // 7: non-git workspace — content-first delta with no git status at all.
  const ws = await mkdtemp(join(tmpdir(), 'temporal-gitev-nogit-'))
  try {
    await writeFile(join(ws, 'note.txt'), 'v1\n')
    const start = await collector.baseline(ws)
    await wait(30)
    await writeFile(join(ws, 'note.txt'), 'v2 by agent\n')
    let prev = start
    let collected = await collector.collect(ws, start, prev, [], [], 'completed')
    check('nongit_content_change_detected', collected.bundle.changedFiles.includes('note.txt') && collected.bundle.turnChangedFiles.includes('note.txt'))
    prev = collected.snapshot

    await wait(30)
    await writeFile(join(ws, 'note.txt'), 'v3 by agent\n')
    collected = await collector.collect(ws, start, prev, [], [], 'completed')
    check('nongit_second_turn_delta_detected', collected.bundle.turnChangedFiles.includes('note.txt'))
    prev = collected.snapshot

    await wait(30)
    const content = await (await import('node:fs/promises')).readFile(join(ws, 'note.txt'), 'utf8')
    await writeFile(join(ws, 'note.txt'), content)
    const rewrite = await collector.collect(ws, start, prev, [], [], 'completed')
    check('nongit_same_content_rewrite_ignored', !rewrite.bundle.turnChangedFiles.includes('note.txt'))
  } finally {
    await rm(ws, { recursive: true, force: true })
  }
}

const failed = Object.entries(checks).filter(([, ok]) => !ok)
console.log(JSON.stringify({ checks, passed: failed.length === 0, failed: failed.map(([name]) => name) }, null, 2))
process.exit(failed.length === 0 ? 0 : 1)
