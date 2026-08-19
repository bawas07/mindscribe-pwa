/**
 * W8 — service-worker runtime caching for model + wasm assets.
 *
 * The app shell stays in the standard generateSW precache (unchanged). The
 * big, rarely-changing binaries get their own cache-first runtime caches so
 * that, once fetched for the first time, later app opens work fully
 * offline — and a model update re-fetches instead of serving stale weights.
 *
 * Versioning: bump MODEL_VERSION in src/lib/model/wllama-client.ts. The
 * version rides as a query param on the GGUF shard URLs, so the exact cache
 * key changes on a bump and CacheFirst misses + re-downloads. Cache names
 * are versioned here too, as documentation of that intent.
 *
 * W12 does the full hardening (scope/quota budgets, iOS eviction handling,
 * COOP/COEP for multi-thread). Kept deliberately small for W8.
 */
export interface SwRuntimeCacheEntry {
  urlPattern: (ctx: { url: URL }) => boolean
  handler: 'CacheFirst'
  options: {
    cacheName: string
    expiration: { maxEntries: number; maxAgeSeconds: number }
    cacheableResponse: { statuses: number[] }
  }
}

/** Cache for the versioned GGUF shards under /models/ (657 MB total, 2 files). */
export const modelWeightsRuntimeCache: SwRuntimeCacheEntry = {
  urlPattern: ({ url }) => url.pathname.startsWith('/models/'),
  handler: 'CacheFirst',
  options: {
    cacheName: 'model-weights-v1',
    // Bounded: exactly the 2 chunk files. 1 year — a genuine model bump
    // re-fetches via the ?v= query on the URL, not via expiry.
    expiration: { maxEntries: 2, maxAgeSeconds: 60 * 60 * 24 * 365 },
    cacheableResponse: { statuses: [0, 200] },
  },
}

/** Cache for the self-hosted primary + Safari-compat WASM builds (public/wasm/). */
export const wasmRuntimeCache: SwRuntimeCacheEntry = {
  urlPattern: ({ url }) => url.pathname.startsWith('/wasm/'),
  handler: 'CacheFirst',
  options: {
    cacheName: 'wasm-assets-v1',
    expiration: { maxEntries: 4, maxAgeSeconds: 60 * 60 * 24 * 30 },
    cacheableResponse: { statuses: [0, 200] },
  },
}

/** All W8 runtime caches, consumed by vite-plugin-pwa's `workbox` option. */
export const swRuntimeCaches: SwRuntimeCacheEntry[] = [modelWeightsRuntimeCache, wasmRuntimeCache]
