/**
 * W8 — download-model.mjs sanity checks.
 *
 * Validates the script's contract WITHOUT performing the 657 MB fetch: the
 * source URL, expected SHA-256 (from docs/spike-model.md §2), the split
 * shard naming (`-0000N-of-0000M.gguf`, which wllama auto-joins) and the
 * <= 512 MB chunk budget (spike G5). The script only runs its fetch/split
 * when executed directly, so importing here is side-effect free.
 */
import { describe, expect, it } from 'vitest'
import {
  EXPECTED_SHA256,
  HF_RESOLVE_BASE,
  MAX_SHARD_BYTES,
  MODEL_REPO_ID,
  MODEL_SOURCE_URL,
  SHARD_COUNT,
  SHARD_FILENAMES,
  SOURCE_FILENAME,
  ggufShardName,
} from '../download-model.mjs'
import { MODEL_FILENAMES } from '../../src/lib/model/wllama-client'

describe('download-model script contract', () => {
  it('points at the official OpenBMB GGUF resolve URL', () => {
    expect(MODEL_REPO_ID).toBe('openbmb/MiniCPM5-1B-GGUF')
    expect(MODEL_SOURCE_URL).toBe(
      `${HF_RESOLVE_BASE}/openbmb/MiniCPM5-1B-GGUF/resolve/main/${SOURCE_FILENAME}`,
    )
    expect(SOURCE_FILENAME).toBe('MiniCPM5-1B-Q4_K_M.gguf')
  })

  it('records the SHA-256 verified in the W3 spike', () => {
    expect(EXPECTED_SHA256).toBe(
      '81b64d05a23b17b34c475f42b3e72fbde62d4b92cc34541f7a8031d0752deafa',
    )
  })

  it('produces the auto-join shard names the client expects to load', () => {
    expect(SHARD_COUNT).toBe(2)
    expect(ggufShardName(1)).toBe('MiniCPM5-1B-Q4_K_M-00001-of-00002.gguf')
    expect(ggufShardName(2)).toBe('MiniCPM5-1B-Q4_K_M-00002-of-00002.gguf')
    // Strong wiring check: what the script writes == what the client loads.
    expect(SHARD_FILENAMES).toEqual([...MODEL_FILENAMES])
  })

  it('respects the <= 512 MB wllama chunk budget', () => {
    expect(MAX_SHARD_BYTES).toBeLessThanOrEqual(512 * 1000 * 1000)
  })
})
