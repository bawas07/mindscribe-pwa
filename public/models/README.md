# Model weights — how to fetch

The MiniCPM5-1B Q4_K_M GGUF (~657 MB) is deliberately **not** committed to
git (`public/models/*` is gitignored — only this README is tracked). It IS
runtime-cached by the PWA's service worker after the first fetch, so a
blank `public/models/` is fine during development: the app downloads the
weights on first use (see the "Setting up your private AI" sheet).

## Files this directory should contain after `npm run model:fetch`

The single 657 MB file is too large for one wllama download (wllama
recommends <= 512 MB chunks, spike G5), so it is served as **2 split
shards** — `--split-max-size 512M` via llama.cpp's `llama-gguf-split`:

| File | Approx. size |
| --- | --- |
| `MiniCPM5-1B-Q4_K_M-00001-of-00002.gguf` | ~330 MB |
| `MiniCPM5-1B-Q4_K_M-00002-of-00002.gguf` | ~330 MB |

`loadModelFromUrl()` (in `src/lib/model/wllama-client.ts`) is handed only
the first shard; wllama auto-joins the rest from the `-0000N-of-0000M`
filename pattern.

## Fetching

```bash
npm run model:fetch
```

The script (scripts/download-model.mjs):

1. Skips if both shards are already present and <= 512 MB (idempotent;
   pass `--force` to wipe and re-download anyway: `npm run model:fetch -- --force`).
2. Downloads pre-split official chunks from `openbmb/MiniCPM5-1B-GGUF` if
   OpenBMB ever publishes them (currently they only ship single files).
3. Otherwise downloads `MiniCPM5-1B-Q4_K_M.gguf` from
   `https://huggingface.co/openbmb/MiniCPM5-1B-GGUF/resolve/main/MiniCPM5-1B-Q4_K_M.gguf`,
   verifies its SHA-256
   (`81b64d05a23b17b34c475f42b3e72fbde62d4b92cc34541f7a8031d0752deafa`,
   from docs/spike-model.md §2) and splits it with `llama-gguf-split`.

**Requires `llama-gguf-split`** (part of llama.cpp): `brew install llama.cpp`
or build from https://github.com/ggml-org/llama.cpp (binary shipped in
prebuilt releases).

## Re-fetching when the model updates

Bump `MODEL_VERSION` in `src/lib/model/wllama-client.ts`. The version is
appended as a query param on the shard URLs (`?v=1`), which changes the
service-worker cache key and wllama's internal blob-cache key, forcing a
one-time re-download. Then rebuild + re-run `npm run model:fetch` if local
shards need refreshing too.

## WASM binaries (not the GGUF)

The wllama primary + Safari-compat WASM live in `public/wasm/` and **are**
committed (they're ~24 MB total and required for the offline build). They
are copied from `node_modules` by:

```bash
npm run model:sync-wasm
```

Run it after upgrading `@wllama/wllama` / `@wllama/wllama-compat`. The
client never references a CDN (see spike C3). It also appends a
cache-bust `?v=` to the wasm URLs — bump `WASM_VERSION` in
`src/lib/model/wllama-client.ts` on any wllama upgrade so the service
worker re-fetches the new wasm (and the app never serves stale wasm
against new JS).
