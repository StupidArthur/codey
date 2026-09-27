/**
 * Ensures Electron's runtime binary is present before electron-builder runs.
 *
 * Electron 44 no longer ships a `postinstall` hook: the official package
 * downloads its binary lazily from `index.js`/`install.js` on first use
 * (electron/electron#52481). `pnpm install` therefore leaves
 * `node_modules/electron/dist` absent, and `electron-builder` fails because
 * `electronDist` points at that directory. This step materializes it the same
 * way Electron itself would, so `pnpm dist:win` works on a clean checkout.
 */
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const electronDir = join(root, 'node_modules', 'electron')
const installer = join(electronDir, 'install.js')
const dist = join(electronDir, 'dist')
const binary = process.platform === 'win32'
  ? 'electron.exe'
  : process.platform === 'darwin' ? 'Electron.app' : 'electron'

if (!existsSync(installer)) {
  console.error(`[prepare-electron] Electron package not found at ${electronDir}. Run 'pnpm install' first.`)
  process.exit(1)
}

if (existsSync(join(dist, binary))) {
  console.log('[prepare-electron] Electron runtime already present')
  process.exit(0)
}

console.log('[prepare-electron] Electron runtime missing; downloading via electron/install.js...')
const result = spawnSync(process.execPath, [installer], { stdio: 'inherit', cwd: root })
if (result.error) {
  console.error(`[prepare-electron] Failed to run Electron installer: ${result.error.message}`)
  process.exit(1)
}
if (result.status !== 0) {
  console.error(`[prepare-electron] Electron installation failed (exit ${result.status})`)
  process.exit(result.status ?? 1)
}
console.log('[prepare-electron] Electron runtime ready')
