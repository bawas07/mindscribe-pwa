#!/usr/bin/env node
/**
 * scripts/sync-wasm.mjs — copy the self-hosted wllama binaries into public/.
 *
 * The PWA must never reach for a CDN (spike C3 / G3 — wllama defaults to
 * jsDelivr for its Safari-compat assets). This script materialises:
 *   - the primary WASM build  -> public/wasm/wllama.wasm
 *   - the compat (Asyncify)   -> public/wasm/compat/{wllama.js,wllama.wasm}
 *
 * Run `npm run model:sync-wasm` whenever @wllama/wllama or
 * @wllama/wllama-compat is upgraded, so the pinned copies match the package
 * versions the app actually imports.
 */
import { mkdir, copyFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const JOB = [
  {
    from: require.resolve('@wllama/wllama/esm/wasm/wllama.wasm'),
    to: path.join(root, 'public/wasm/wllama.wasm'),
  },
  {
    from: require.resolve('@wllama/wllama-compat/wasm/wllama.js'),
    to: path.join(root, 'public/wasm/compat/wllama.js'),
  },
  {
    from: require.resolve('@wllama/wllama-compat/wasm/wllama.wasm'),
    to: path.join(root, 'public/wasm/compat/wllama.wasm'),
  },
]

await mkdir(path.join(root, 'public/wasm/compat'), { recursive: true })

for (const { from, to } of JOB) {
  await copyFile(from, to)
  process.stdout.write(`[model:sync-wasm] copied ${path.relative(root, from)} -> ${path.relative(root, to)}\n`)
}

process.stdout.write('[model:sync-wasm] done.\n')
