import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { VitePWA } from 'vite-plugin-pwa'
import { swRuntimeCaches } from './sw-runtime-caching'

// PWA config: generateSW precaches the built app shell (HTML/CSS/JS + fonts).
// Big, versioned binaries (GGUF weights + WASM) stay OUT of the precache and
// use cache-first runtime caching (W8): fetched once on first use, served
// fully offline afterward, re-fetched only on a model version bump. See
// ./sw-runtime-caching.ts (W12 hardens: quota/eviction, COOP/COEP).
export default defineConfig({
  plugins: [
    vue(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['icon.svg'],
      workbox: {
        // App-shell-only precache: JS/CSS/HTML + self-hosted fonts + icons.
        // The big, versioned binaries (wasm/, models/) are deliberately kept
        // OUT of the precache — they are runtime-cached below. Two reasons:
        // (1) 657 MB in the precache manifest is wrong; (2) workbox's default
        // maximumFileSizeToCacheInBytes (2 MiB) rejects wasm entirely.
        globPatterns: ['**/*.{js,css,html,woff,woff2,svg,png,ico,webmanifest,json}'],
        globIgnores: ['**/wasm/**', '**/models/**'],
        runtimeCaching: swRuntimeCaches,
      },
      manifest: {
        name: 'MindScribe',
        short_name: 'MindScribe',
        description: 'A local-first reflective journal. Everything stays on your device.',
        theme_color: '#15130f',
        background_color: '#15130f',
        display: 'standalone',
        start_url: '/',
        icons: [
          {
            src: 'icon.svg',
            sizes: 'any',
            type: 'image/svg+xml',
          },
        ],
      },
    }),
  ],
})
