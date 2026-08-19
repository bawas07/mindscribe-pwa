#!/usr/bin/env node
/**
 * scripts/download-model.mjs — fetch + split the MiniCPM5-1B Q4_K_M GGUF.
 *
 * The 657 MB GGUF must not live in git (docs/architecture.md: weights are
 * fetched once on first use and SW-cached). This script materialises the
 * split chunks under public/models/ so the PWA can serve them at runtime.
 *
 * Strategy (spike G5 + W8 decision):
 *   1. If the two shards already exist under public/models/ and each is
 *      <= 512 MB, we're done (idempotent).
 *   2. Pre-split official chunks: openbmb/MiniCPM5-1B-GGUF currently ships
 *      only single-file GGUFs (verified on HF), but if the repo later adds
 *      `-00001-of-00002.gguf` files, download them directly.
 *   3. Otherwise download the single file and split it with
 *      `llama-gguf-split --split-max-size 512M` (llama.cpp tool). The
 *      output files follow the `-0000N-of-0000M.gguf` convention that
 *      wllama's loadModelFromUrl() auto-joins.
 *
 * SHA-256 (from docs/spike-model.md §2) is verified on the single file;
 * chunk sizes are re-checked after splitting.
 *
 * Exit code is non-zero on any failure so CI / a human agent can react.
 */
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { createHash } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { access, mkdir, readdir, rm, stat } from 'node:fs/promises'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const execFileAsync = promisify(execFile)

// ---------------------------------------------------------------------------
// Exported contract — imported by unit tests for a sanity check (URL, SHA,
// shard naming). Keep these in sync with src/lib/model/wllama-client.ts.
// ---------------------------------------------------------------------------

export const MODEL_REPO_ID = 'openbmb/MiniCPM5-1B-GGUF'
export const SOURCE_FILENAME = 'MiniCPM5-1B-Q4_K_M.gguf'
/** SHA-256 of MiniCPM5-1B-Q4_K_M.gguf, recorded in docs/spike-model.md §2. */
export const EXPECTED_SHA256 =
  '81b64d05a23b17b34c475f42b3e72fbde62d4b92cc34541f7a8031d0752deafa'
export const HF_RESOLVE_BASE = 'https://huggingface.co'
export const MODEL_SOURCE_URL = `${HF_RESOLVE_BASE}/${MODEL_REPO_ID}/resolve/main/${SOURCE_FILENAME}`
export const SHARD_COUNT = 2
export const SHARD_PREFIX = 'MiniCPM5-1B-Q4_K_M'
/** wllama guidance (spike G5): chunks should be <= 512 MB. */
export const MAX_SHARD_BYTES = 512 * 1000 * 1000
export const MODELS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../public/models',
)

/** gguf-split output naming, e.g. -00001-of-00002.gguf — wllama auto-joins by this pattern. */
export function ggufShardName(index, total = SHARD_COUNT) {
  return `${SHARD_PREFIX}-${String(index).padStart(5, '0')}-of-${String(total).padStart(5, '0')}.gguf`
}

export const SHARD_FILENAMES = Object.freeze(
  Array.from({ length: SHARD_COUNT }, (_, i) => ggufShardName(i + 1)),
)

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function log(message) {
  process.stdout.write(`[model:fetch] ${message}\n`)
}

function formatBytes(bytes) {
  if (bytes <= 0) return '0 MB'
  const mb = bytes / (1024 * 1024)
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.round(mb)} MB`
}

async function pathExists(filePath) {
  try {
    await access(filePath)
    return true
  } catch {
    return false
  }
}

function sha256Stream() {
  return createHash('sha256')
}

async function downloadFile(url, destPath, expectedSha256) {
  const response = await fetch(url)
  if (!response.ok || !response.body) {
    throw new Error(`download failed: HTTP ${response.status} for ${url}`)
  }
  const totalBytes = Number(response.headers.get('content-length') ?? 0)
  let loadedBytes = 0
  const hash = sha256Stream()
  const progress = new Transform({
    transform(chunk, _encoding, callback) {
      loadedBytes += chunk.length
      hash.update(chunk)
      const percent = totalBytes > 0 ? Math.round((loadedBytes / totalBytes) * 100) : 0
      process.stdout.write(
        `\r[model:fetch] ${formatBytes(loadedBytes)} / ${formatBytes(totalBytes)} (${percent}%)`,
      )
      callback(null, chunk)
    },
  })
  await pipeline(Readable.fromWeb(response.body), progress, createWriteStream(destPath))
  process.stdout.write('\n')

  const actual = hash.digest('hex')
  if (actual !== expectedSha256) {
    throw new Error(
      `SHA-256 mismatch for ${destPath}\n  expected ${expectedSha256}\n  actual   ${actual}`,
    )
  }
}

async function hasLlamaGgufSplit() {
  try {
    const { stderr } = await execFileAsync('llama-gguf-split', ['--version'])
    const firstLine = stderr.trim().split('\n')[0] ?? 'unknown version'
    log(`found llama-gguf-split (${firstLine})`)
    return true
  } catch {
    return false
  }
}

async function shardStatus() {
  const shards = []
  for (const name of SHARD_FILENAMES) {
    const sizeStat = await stat(path.join(MODELS_DIR, name)).catch(() => null)
    const size = sizeStat?.size ?? 0
    shards.push({ name, size, ok: size > 0 && size <= MAX_SHARD_BYTES })
  }
  return shards
}

async function validateFinalShards() {
  const shards = await shardStatus()
  const bad = shards.filter((s) => !s.ok)
  if (bad.length > 0) {
    throw new Error(
      `invalid shards: ${bad.map((s) => `${s.name} (${s.size} bytes)`).join(', ')}`,
    )
  }
  return shards
}

/** Download the pre-split official chunks if the HF repo ever ships them. */
async function tryOfficialPreSplit() {
  for (const name of SHARD_FILENAMES) {
    const url = `${HF_RESOLVE_BASE}/${MODEL_REPO_ID}/resolve/main/${name}`
    const head = await fetch(url, { method: 'HEAD' })
    if (!head.ok) return false
  }
  await mkdir(MODELS_DIR, { recursive: true })
  for (const name of SHARD_FILENAMES) {
    log(`downloading pre-split shard ${name}`)
    await downloadFile(
      `${HF_RESOLVE_BASE}/${MODEL_REPO_ID}/resolve/main/${name}`,
      path.join(MODELS_DIR, name),
    )
  }
  await validateFinalShards()
  return true
}

/** Split the downloaded single file with llama-gguf-split (llama.cpp tool). */
async function splitWithLlamaGgufSplit(fullPath) {
  const outPrefix = path.join(MODELS_DIR, SHARD_PREFIX)
  log('splitting with llama-gguf-split (max 512 MB / shard)')
  await new Promise((resolve, reject) => {
    const child = spawn(
      'llama-gguf-split',
      ['--split', '--split-max-size', '512M', fullPath, outPrefix],
      { stdio: 'inherit' },
    )
    child.on('error', reject)
    child.on('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(`llama-gguf-split exited with code ${code}`)),
    )
  })
  await validateFinalShards()
  log(`split produced: ${SHARD_FILENAMES.join(', ')}`)
}

// ---------------------------------------------------------------------------
// Entry point (runs only when executed directly, so unit tests can import the
// constants above without triggering a 657 MB download).
// ---------------------------------------------------------------------------

async function main() {
  await mkdir(MODELS_DIR, { recursive: true })

  const force = process.argv.includes('--force')

  if (!force && (await shardStatus()).every((s) => s.ok)) {
    log('shards already present — nothing to do. (Use --force to re-download.)')
    return
  }

  if (force) {
    log('--force: wiping existing shards and re-downloading.')
  }

  // Partial / stale shards: wipe so a fresh run is deterministic.
  for (const file of await readdir(MODELS_DIR)) {
    if (file.endsWith('.gguf')) {
      await rm(path.join(MODELS_DIR, file), { force: true })
    }
  }

  // 1) Pre-split official chunks (future-proof; OpenBMB currently ships single files).
  if (await tryOfficialPreSplit()) return

  // 2) Single file + llama-gguf-split.
  if (!(await hasLlamaGgufSplit())) {
    throw new Error(
      `no pre-split chunks in ${MODEL_REPO_ID} and llama-gguf-split is not on PATH.\n` +
        `Install llama.cpp (brew install llama.cpp) or build llama-gguf-split, then re-run ` +
        `npm run model:fetch. See public/models/README.md.`,
    )
  }

  log(`downloading ${MODEL_SOURCE_URL}`)
  const fullPath = path.join(MODELS_DIR, SOURCE_FILENAME)
  await downloadFile(MODEL_SOURCE_URL, fullPath, EXPECTED_SHA256)
  log('SHA-256 verified.')

  await splitWithLlamaGgufSplit(fullPath)
  await rm(fullPath, { force: true })

  const final = await validateFinalShards()
  log(`done: ${final.map((s) => `${s.name} (${formatBytes(s.size)})`).join(', ')}`)
}

const isDirectRun =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href

if (isDirectRun) {
  main().catch((error) => {
    process.stderr.write(`\n[model:fetch] ERROR: ${error.message}\n`)
    process.exit(1)
  })
}
