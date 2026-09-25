/**
 * Phase-1 acceptance probe: a projected legacy DSH Session must not duplicate
 * after the product store is reopened (simulated app restart).
 *
 *   node scripts/probes/dsh-discovery-persistence.mjs
 */
import { createRequire } from 'node:module'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, '..', '..')
const require = createRequire(import.meta.url)
const esbuild = require(join(repoRoot, 'node_modules/.pnpm/esbuild@0.25.12/node_modules/esbuild/lib/main.js'))

async function bundle(entry, outfile, external) {
  await esbuild.build({ entryPoints: [join(repoRoot, entry)], bundle: true, platform: 'node', format: 'cjs', outfile, external, logLevel: 'silent' })
  return require(outfile)
}

const { ProductStore } = await bundle('src/main/persistence/ProductStore.ts', join(here, '.cache-product-store.cjs'), ['better-sqlite3'])
const { mergeSessions } = await bundle('src/main/dsh/sessionMerge.ts', join(here, '.cache-session-merge.cjs'), [])

const root = await mkdtemp(join(tmpdir(), 'temporal-persist-'))
const dbPath = join(root, 'product.sqlite')
const workspace = join(root, 'workspace')

const first = new ProductStore(dbPath)
const created = first.createSession(workspace, 'dsh-legacy-1', 'Existing DSH Session')
const productFirst = first.listSessions(workspace)
first.close()

const second = new ProductStore(dbPath)
const productAfterRestart = second.listSessions(workspace)
second.close()

const discovered = [
  { id: 'dsh-legacy-1', workspacePath: workspace },
  { id: 'dsh-legacy-2', workspacePath: workspace }
]
const mergedBefore = mergeSessions(productFirst, discovered, workspace)
const mergedAfter = mergeSessions(productAfterRestart, discovered, workspace)

const assertions = {
  projectionStored: productFirst.length === 1 && productFirst[0].id === created.id && productFirst[0].dshSessionId === 'dsh-legacy-1',
  projectionIsLegacy: productFirst[0].kind === 'legacy',
  survivesRestart: productAfterRestart.length === 1 && productAfterRestart[0].id === created.id,
  noDuplicateBeforeRestart: mergedBefore.filter((s) => s.dshSessionId === 'dsh-legacy-1').length === 1,
  noDuplicateAfterRestart: mergedAfter.filter((s) => s.dshSessionId === 'dsh-legacy-1').length === 1,
  legacyStillListed: mergedAfter.filter((s) => s.dshSessionId === 'dsh-legacy-2').length === 1,
  mergedCounts: mergedAfter.length === 2
}
console.log(JSON.stringify({ createdId: created.id.slice(0, 8), assertions, passed: Object.values(assertions).every(Boolean) }, null, 2))
if (!Object.values(assertions).every(Boolean)) process.exitCode = 1
