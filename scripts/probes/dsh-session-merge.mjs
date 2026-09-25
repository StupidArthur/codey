/**
 * Phase-1 acceptance probe for the product/ACP session merge semantics.
 * Bundles the real `sessionMerge.ts` and asserts dedupe, kind and history state.
 *
 *   node scripts/probes/dsh-session-merge.mjs
 */
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, '..', '..')
const require = createRequire(import.meta.url)
const esbuild = require(join(repoRoot, 'node_modules/.pnpm/esbuild@0.25.12/node_modules/esbuild/lib/main.js'))

const bundlePath = join(here, '.cache-session-merge.cjs')
await esbuild.build({
  entryPoints: [join(repoRoot, 'src/main/dsh/sessionMerge.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile: bundlePath,
  logLevel: 'silent'
})
const { mergeSessions, historyStateFor } = require(bundlePath)

const product = [
  { id: 'p1', dshSessionId: 'dsh-a', title: 'A', workspacePath: 'W', updatedAt: '2026-01-01T00:00:10.000Z', hasTemporalHistory: true, kind: 'temporal' },
  { id: 'p2', title: 'New', workspacePath: 'W', updatedAt: '2026-01-01T00:00:05.000Z', hasTemporalHistory: false, kind: 'new' }
]
const discovered = [
  { id: 'dsh-a', workspacePath: 'W', title: 'A native' },
  { id: 'dsh-b', workspacePath: 'W', title: 'Legacy B', updatedAt: '2026-01-01T00:00:20.000Z' },
  { id: 'dsh-b', workspacePath: 'W', title: 'Legacy B dup', updatedAt: '2026-01-01T00:00:19.000Z' }
]
const merged = mergeSessions(product, discovered, 'W')
const assertions = {
  noDuplicateIds: new Set(merged.map((s) => s.id)).size === merged.length,
  projectedDshWinsOnce: merged.filter((s) => s.dshSessionId === 'dsh-a').length === 1 && merged.find((s) => s.dshSessionId === 'dsh-a').id === 'p1',
  discoveredAppearsOnce: merged.filter((s) => s.dshSessionId === 'dsh-b').length === 1,
  discoveredKindLegacy: merged.find((s) => s.dshSessionId === 'dsh-b')?.kind === 'legacy',
  discoveredTitleFallsBack: mergeSessions([], [{ id: 'dsh-c', workspacePath: 'W' }], 'W')[0].title === 'Existing DSH Session',
  sortedNewestFirst: JSON.stringify(merged.map((s) => s.id)) === JSON.stringify(['dsh-b', 'p1', 'p2']),
  historyLegacyNoRounds: historyStateFor({ id: 'x', kind: 'legacy', title: '', workspacePath: 'W', updatedAt: '', hasTemporalHistory: false }, 0) === 'legacy-unavailable',
  historyLegacyWithRounds: historyStateFor({ id: 'x', kind: 'legacy', title: '', workspacePath: 'W', updatedAt: '', hasTemporalHistory: false }, 1) === 'none',
  historyNewNone: historyStateFor({ id: 'x', kind: 'new', title: '', workspacePath: 'W', updatedAt: '', hasTemporalHistory: false }, 0) === 'none',
  historyNullNone: historyStateFor(null, 0) === 'none'
}
console.log(JSON.stringify({ merged: merged.map((s) => ({ id: s.id, dshSessionId: s.dshSessionId, kind: s.kind })), assertions, passed: Object.values(assertions).every(Boolean) }, null, 2))
if (!Object.values(assertions).every(Boolean)) process.exitCode = 1
