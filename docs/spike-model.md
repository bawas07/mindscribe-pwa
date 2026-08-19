# W3 Spike Report — Model: MiniCPM5-1B (Q4_K_M) via wllama

> Date: 2026-08-19 · Status: **CONDITIONAL GO** (3 mandatory design adjustments, below)
> Scope: research + hands-on validation of D4 (MiniCPM5-1B, Q4_K_M GGUF, 657 MB, via wllama)

## 0. Verdict (TL;DR)

**CONDITIONAL GO.** MiniCPM5-1B loads and runs correctly through `@wllama/wllama` — the hybrid `<think>` chat template, `enable_thinking` kwargs, and tokenizer all work end-to-end. Integration has **no showstoppers**. Quality is viable for the follow-up task (Task A) with a tuned prompt, and viable for the summary task (Task B) **only if the app computes the numeric fields itself** (the 1B model cannot count reliably). The MiniCPM3-4B fallback is **not needed for M1** given the Task B redesign; revisit only if dogfooding fails Task A quality. Desktop CPU numbers are indicative, not mobile truth (device matrix remains W12).

Conditions (must land before/with W8–W11):
1. **Task B split**: model returns theme phrases only; `last_mentioned_days_ago` / `mention_count` computed deterministically in app code (JS) by matching themes against entries.
2. **Task A config**: few-shot example + `temperature: 0.5`, no-think mode, plus a light output validator (starts with a question mark presence / ends with "?"; ≤ 1 retry at temp 0.7).
3. **Self-host compat assets** for iOS/Safari (see §6, gotcha G3).

## 1. wllama compatibility research

- **Package**: the unscoped `wllama` npm package **no longer exists** (404). Official package is **`@wllama/wllama`**, latest **3.6.0** (2026-08-16), MIT, author ngxson, same repo. W1 already resolved `@wllama/wllama@3.6.0` — plan docs should be updated to reference the scoped name.
- **Bundled llama.cpp**: release notes show syncs to upstream llama.cpp (v3.5.0 in 3.5.x; 3.6.0 "sync latest llama.cpp source code"). Recent enough for MiniCPM5: no llama.cpp fork needed — MiniCPM5 is standard `LlamaForCausalLM` (confirmed by model card + GGUF metadata: `general.architecture = llama`, 24 blocks, 1536 embed, 16 Q / 2 KV heads, 131072 ctx).
- **Chat template**: the GGUF **embeds the full Jinja template** (`tokenizer.chat_template` in metadata) — no template override needed. The MiniCPM5 template honors `enable_thinking`: undefined → no think block (hybrid); `false` → empty `<think></think>` (no-think); `true` → open `<think>` (reasoning). **wllama forwards arbitrary template kwargs**: `LoadModelParams.default_template_kwargs` (applied to every request) and per-request `ChatCompletionParams.chat_template_kwargs`. Verified empirically (§5).
- **Think extraction**: llama-server extracts `<think>...</think>` into `message.reasoning_content`; wllama surfaces it in the OAI-compatible response. With thinking on, reasoning consumes the token budget — a 256-token cap produced reasoning-only responses with empty `content`.
- **Threading / WASM**: default build needs JSPI + Memory64 (Chromium ✓). Single- vs multi-thread WASM is auto-switched; MT requires COOP/COEP headers in the browser. wllama is worker-based; no main-thread mode.
- **Safari/iOS**: no JSPI/Memory64 → auto **compat mode** (`@wllama/wllama-compat`, Asyncify build) — "significantly lower performance" per wllama docs, 🟡 acceptable. See gotcha G3.
- **Known limits**: max 2 GB/model file (ArrayBuffer) — 657 MB is fine. wllama recommends **splitting into ≤512 MB chunks** (parallel download + lower OOM risk) — relevant for W8. IQ quants discouraged. No known issues with newer Llama architectures in 3.6.0.
- **License**: MiniCPM5-1B and GGUF are **Apache-2.0** ✓ (plan open question resolved).

## 2. Hands-on validation setup

wllama officially targets browsers only (worker + `URL.createObjectURL` + OPFS/COS storage). To run the **same WASM build** in Node 24 for this spike, I shimmed the browser surface with worker_threads:

- Main thread: `self`, `location.href`, a `URL.createObjectURL` blob registry, and a `Worker` shim that materializes wllama's blob-URL worker code to a temp `.mjs` and spawns a `worker_threads.Worker`.
- Worker file prelude: `require` via `createRequire`, `__filename`/`__dirname`, `self`/`postMessage`/`onmessage` bridges (filtered to `{verb,...}` wllama task messages), blob-URL registry + `Worker` property trap so emscripten's pthread spawns route through temp files.
- Injected an in-memory `StorageBackend` via `CacheManager` (OPFS/COS don't exist in Node).
- `wllama.setCompat(null)` — **3.6.0's constructor unconditionally calls `setCompat("default")`**, which would pull compat assets from jsDelivr when JSPI is missing (Node), conflicting with offline requirements (see G3).

The full harness is reproducible: `npm i @wllama/wllama` → `loadModel([new Blob([fs.readFileSync('MiniCPM5-1B-Q4_K_M.gguf')])], …)` → `createChatCompletion(...)`. Model download: HF direct link, 657 MB in ~72 s @ ~9.8 MB/s; SHA-256 verified `81b64d05a23b17b34c475f42b3e72fbde62d4b92cc34541f7a8031d0752deafa`.

Node MT (4 threads) worked after the pthread shim (emscripten's Node branch spawns pthread workers with `workerData:'em-pthread'`; my trap intercepts and writes the glue-only worker file). This recipe can back future W8/W10/W11 Node-based tests.

## 3. Measured numbers (desktop, 8-core, Node 24; WASM CPU-only, `n_gpu_layers: 0`, `n_ctx: 2048`)

| Metric | Single-thread | Multi-thread (4) |
|---|---|---|
| Model load (fs → wasm heap + weights) | 8.4 s | 4.0–6.0 s |
| Prompt eval | 0.92–1.48 tok/s (~1.09 s/tok) | 4.4–5.2 tok/s (~190–228 ms/tok) |
| Generation | 0.89 tok/s | 1.6–2.8 tok/s |
| Peak RSS | ~2.3 GB | ~2.4 GB (settles ~1.8 GB after GC) |

- Task A wall time (191-token prompt, MT): ~44 s cold; **~13 s when the KV cache is reused** (identical prompt) — llama-server cache reuse works, so the 2nd follow-up in W10 is much faster than the 1st.
- **These are NOT mobile numbers.** Expect mobile CPU to be slower (this desktop's CPU throughput under wasm was itself modest — the box was partially loaded); Android Chrome **WebGPU** is the intended fast path (untested here, no GPU in the harness); iOS compat mode will be slower still. W12 device matrix is the real gate for UX.
- Memory is the more serious mobile concern: wasm heap holds the model file (~657 MB, mmap'd) + weights + KV. The 4 GB Memory64 cap fits, but iOS compat (no Memory64) should be split into ≤512 MB chunks (wllama guidance) to reduce peak.

## 4. Task A — gentle follow-up question (verdict: **PASS with tuned config**)

Entry: "Spent the morning stuck on the call-graph traversal, then just stepped away for coffee and it fell into place mid-pour. Monday went the same way but backwards — three hours of pushing and nothing."

System prompt: one gentle reflective question, grounded, warm, non-clinical, banned vocab list, max ~20 words.

| Config | Output (verbatim) | Verdict |
|---|---|---|
| ST, temp 0.7, no example | "What specifically about the call-graph traversal made you feel stuck?" | ✅ PASS |
| MT, temp 0.7, no example | "That sounds like a lot of work." | ❌ FAIL — statement, not a question; generic |
| MT, temp 0.7, no example, retry 1 | "How does this situation make you feel?" | ⚠️ PARTIAL — question, but not grounded in specifics |
| MT, temp 0.7, no example, retry 2 | "What exactly happened during this particular call-graph traversal?" | ✅ PASS |
| MT, temp 0.7, no example, retry 3 | "What specifically caused you to lose focus on the call-graph traversal during the morning?" | ✅ PASS |
| **MT, temp 0.5, few-shot example** | "What was your initial intention when you stepped away from the call-graph?" | ✅ PASS |
| **MT, temp 0.5, few-shot example** | "What did you find most refreshing about stepping away from the call-graph during this particular week?" | ✅ PASS |

**Verdict: PASS** — at temp 0.7 format compliance is ~60–70% (variance is real); with a one-shot example + temp 0.5 it was 2/2, grounded and non-clinical. Ship with few-shot + temp 0.5 + a cheap validator (output ends with "?") and a single retry.

## 5. Task B — theme summary (verdict: **FAIL as specced → PASS with app-side counting**)

3 entries: river walk (12/7/2 days ago), work (7/2), sleep (7/2). Ground truth: 3 themes, counts 3/2/2, last-mentioned 2/2/2.

| Config | Output (verbatim) | Verdict |
|---|---|---|
| Rules-only, temp 0.2 | `{"themes":[{"topic":"long way home past the river","last_mentioned_days_ago":12,"mention_count":1},{"topic":"long day at work","last_mentioned_days_ago":7,"mention_count":1},{"topic":"skipped the river walk","last_mentioned_days_ago":2,"mention_count":1}]}` | ❌ valid JSON, but topics are verbatim fragments and all counts = 1 |
| Few-shot, temp 0.2 | `{"themes":[{"topic":"river walks","last_mentioned_days_ago":7,"mention_count":2}]}` | ⚠️ right theme, wrong numbers (should be 2 / 3); missed work + sleep |
| Full counts, temp 0.1 | ` ```json {"themes":[{"topic":"river","last_mentioned_days_ago":2,"mention_count":1},{"topic":"autumn","last_mentioned_days_ago":3,"mention_count":1},{"topic":"work","last_mentioned_days_ago":7,"mention_count":1}]} ` | ❌ code fence despite ban; hallucinated days (3); counts wrong |
| **Themes-only, few-shot** | `{"themes":["river walk","autumn","work","sleep"],"themes":["harbor visits","river walk","work","sleep"]}` | ⚠️ **duplicate key bug**, but the themes are largely right; leaked the example ("harbor visits") |
| Themes-only, no example | `{"themes":["seasonal change","work-life balance","emotional response","time management"]}` | ⚠️ valid single-key JSON, but themes drift abstract/ungrounded without an example |

**Verdict**: parseable JSON is achievable, theme *naming* is decent (with a grounded example), but the 1B model **cannot reliably count entries or compute recency** — it hallucinates numbers and occasionally emits malformed JSON (duplicate keys, fences). Redesign (Condition 1): model returns `{"themes":[...]}` only; app computes `last_mentioned_days_ago` + `mention_count` by matching theme phrases against entry text (deterministic, testable in W11). Add a JSON validator + 1 retry, and guard against example leakage (rephrase the example or strip known-leak terms).

Bonus finding: `enable_thinking: true` works end-to-end — "What is 7*8?" returned `content: "56"` with verbose step-by-step `reasoning_content` (the template kwargs flow through wllama → llama.cpp correctly). Reasoning consumed 99 tokens for a trivial task and did not improve Task B (hit the 256-token cap with reasoning only, empty `content`) — **use no-think mode (`enable_thinking: false`) for the app.**

## 6. Gotchas

- **G1 — package name**: `wllama` on npm is dead; use `@wllama/wllama` (W1 already has it). Update plan D4/W1 text.
- **G2 — sampling**: temp 0.7 gives ~60–70% format compliance on Task A. Use temp 0.5 + few-shot + validator + retry (Condition 2).
- **G3 — compat CDN vs offline**: wllama 3.6.0 *always* calls `setCompat("default")` in the constructor; on browsers without JSPI/Memory64 (iOS Safari) it fetches compat assets from jsDelivr — **violates the offline PWA requirement**. W8 must: `npm i @wllama/wllama-compat`, copy its `wasm/` into public, and `wllama.setCompat({ worker: '/…/wllama.js', wasm: '/…/wllama.wasm' })` (or pin `setCompat(null)` if iOS is out of scope — not recommended, PRD targets Safari).
- **G4 — MT headers**: multi-thread WASM needs COOP/COEP on the app origin (already a PWA hardening topic for W12).
- **G5 — split the GGUF**: wllama recommends ≤512 MB chunks (parallel download, lower peak memory). 657 MB → 2 chunks via `llama-gguf-split`; `loadModelFromUrl` auto-joins. Decide in W8.
- **G6 — Node tests need shims**: wllama has no Node entry point. The shim recipe in §2 (or an extracted helper module) lets W8–W11 unit-test prompts against the real wasm build in CI without a browser.
- **G7 — memory**: peak ~2.4 GB RSS desktop for 657 MB model. Mobile W12 must measure; iOS compat + 657 MB single-file is the riskiest cell in the matrix.
- **G8 — response hygiene**: Task B outputs can contain code fences / duplicate keys; Task A can return non-questions. Both need the light validation layer (already implied by D5/W10 guardrails).

## 7. Recommended wllama config (for W8 `model/wllama-client.ts`)

```ts
import { Wllama } from '@wllama/wllama';
import WasmFromCDN from '@wllama/wllama/esm/wasm-from-cdn.js'; // not for prod; self-host instead

const wllama = new Wllama({
  // self-hosted paths in the PWA (bundled via Vite public/ + SW precache)
  'default': `${import.meta.env.BASE_URL}wasm/wllama.wasm`,
});

// Self-host compat assets (iOS Safari) — copy from node_modules/@wllama/wllama-compat/wasm/
wllama.setCompat({
  worker: `${import.meta.env.BASE_URL}wasm/compat/wllama.js`,
  wasm:   `${import.meta.env.BASE_URL}wasm/compat/wllama.wasm`,
});

await wllama.loadModelFromUrl(
  `${import.meta.env.BASE_URL}models/MiniCPM5-1B-Q4_K_M-00001-of-00002.gguf`, // split chunks auto-join
  {
    n_gpu_layers: undefined,      // let wllama default: all layers on WebGPU when available
    n_ctx: 2048,                  // follow-up + summary prompts are ~200-400 tokens
    n_threads: undefined,         // auto (hardwareConcurrency/2) when MT is supported
    default_template_kwargs: { enable_thinking: false }, // no-think: faster, no budget burn
    progressCallback: ({ loaded, total }) => { /* first-run download UX */ },
  }
);

// Follow-up question (Task A)
const q = await wllama.createChatCompletion({
  messages: [
    { role: 'system', content: SYSTEM_FOLLOWUP }, // few-shot example + guardrails (see §4)
    { role: 'user', content: entryText },
  ],
  max_tokens: 60,
  temperature: 0.5,
  top_p: 0.95,
  chat_template_kwargs: { enable_thinking: false },
});

// Theme extraction (Task B — themes only; counts computed app-side)
const themes = await wllama.createChatCompletion({
  messages: [
    { role: 'system', content: SYSTEM_THEMES }, // {"themes":["..."]}, grounded example
    { role: 'user', content: entriesWithDaysAgo },
  ],
  max_tokens: 120,
  temperature: 0.2,
  top_p: 0.95,
  chat_template_kwargs: { enable_thinking: false },
});
```

## 8. Fallback assessment (MiniCPM3-4B Q4, ~2.4 GB)

- **Not needed for M1** if Conditions 1–3 are adopted: the 1B model passes the redesigned tasks; the 4B buys counting reliability the app no longer needs from the model.
- Cost of the fallback: 3.7× download (2.4 GB), ~4× memory (~5–6 GB RSS desktop → likely OOM/eviction pressure on mobile), longer loads — all directly against W12's hardest risks.
- Revisit trigger: dogfooding (W13) shows Task A follow-ups consistently unsatisfying despite validator/retry, or users report summaries missing obvious themes. Decision stays reversible: the model is swappable behind `wllama-client.ts` (same GGUF family, same API).

## 9. Open questions carried forward

- Real-device matrix (Android Chrome WebGPU / iOS Safari compat): tok/s, memory, eviction — W12.
- Task B app-side matcher: exact word-overlap vs. fuzzy (embedding) matching — W11 design decision.
- KV-cache reuse benefit across follow-up Q1→Q2 — observed in this spike (~3× faster second call); exploit in W10 by reusing one context session.
