/**
 * W8 — service-worker runtime-cache config assertions.
 *
 * The model weights + WASM binaries must be cache-first runtime caches
 * (fetched once, fully offline afterward, re-fetched only on a version
 * bump) and must stay OUT of the app-shell precache. These tests pin the
 * url patterns, bounded budgets, versioned cache names and the no-CDN rule.
 */
import { describe, expect, it } from 'vitest'
import {
  modelWeightsRuntimeCache,
  swRuntimeCaches,
  wasmRuntimeCache,
} from '../../../sw-runtime-caching'

describe('sw runtime caching (W8)', () => {
  it('routes /models/ to a bounded, versioned, cache-first cache', () => {
    expect(modelWeightsRuntimeCache.handler).toBe('CacheFirst')
    expect(
      modelWeightsRuntimeCache.urlPattern({ url: new URL('https://app/models/MiniCPM5-1B-Q4_K_M-00001-of-00002.gguf?v=1') }),
    ).toBe(true)
    expect(
      modelWeightsRuntimeCache.urlPattern({ url: new URL('https://app/assets/index.js') }),
    ).toBe(false)
    expect(modelWeightsRuntimeCache.options.cacheName).toBe('model-weights-v1')
    expect(modelWeightsRuntimeCache.options.expiration.maxEntries).toBeGreaterThanOrEqual(2)
  })

  it('routes /wasm/ to a cache-first cache', () => {
    expect(wasmRuntimeCache.handler).toBe('CacheFirst')
    expect(
      wasmRuntimeCache.urlPattern({ url: new URL('https://app/wasm/compat/wllama.wasm') }),
    ).toBe(true)
    expect(
      wasmRuntimeCache.urlPattern({ url: new URL('https://app/index.html') }),
    ).toBe(false)
    expect(wasmRuntimeCache.options.cacheName).toBe('wasm-assets-v1')
  })

  it('contains only the model + wasm caches, with no CDN references', () => {
    expect(swRuntimeCaches).toEqual([modelWeightsRuntimeCache, wasmRuntimeCache])
    expect(JSON.stringify(swRuntimeCaches)).not.toMatch(/jsdelivr|cdn\./i)
  })
})
