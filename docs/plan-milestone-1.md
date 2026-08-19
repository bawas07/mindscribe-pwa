# MindScribe — Milestone 1 Plan (Phase 1: Core Loop)

> Status: Draft for approval · Supersedes the planning-time notes in `milestones.md` for M1 scope.
> Sources: `prd.md`, `architecture.md`, `data-schema.md`, `flow.md`, `example.html` wireframes.

## Goal

Prove the core loop works end-to-end, fully offline, on-device: **write an entry → get gently unstuck when needed → see it on the dashboard → come back to it later.** Everything runs in the browser — no server component, no network dependency after first load.

## Decisions (confirmed with user)

| # | Decision | Rationale |
|---|---|---|
| D1 | **New Entry UI: journal-first** — blank writing area is the artifact; prompts/follow-ups are light aside cards, not a chat thread | PRD positioning ("journal-primary, not chat-primary"); `flow.md` wireframe notes |
| D2 | **Design refresh is a planning-phase gate**: produce an updated `example.html` showing journal-first entry screens (+ onboarding frame) during planning, get sign-off **before any implementation starts** | Existing wireframes only show chat-style entry; user wants to see journal-first before committing |
| D3 | **PIN lock deferred to M1.1** — M1 ships at-rest encryption via device-generated key only (no KDF needed) | Encryption is in scope from day one; the optional PIN toggle adds KDF + unlock-screen complexity without core-loop value |
| D4 | **Model: MiniCPM5-1B, Q4_K_M GGUF (657 MB) via wllama** | 1B-class SOTA, official OpenBMB GGUF, standard Llama architecture (no llama.cpp fork), only ~60% larger than MiniCPM4-0.5B with 2× params. 8B variants are browser-infeasible (~4.5GB+). Fallback if quality gate fails: MiniCPM3-4B Q4 (~2.4GB) |
| D5 | **Follow-ups are opt-in, user-initiated** — after Done the app asks "Want to talk about this?"; the model never interjects on its own; gentle questions (max 2) only appear after the user says yes | User decision: keeps the unstuck/reflection moment while removing the CBT-adjacent feel of unsolicited follow-ups |
| D6 | **Swipe-peek at referenced entries** — each follow-up question carries the ids of the entries it was grounded in (`referenced_entry_ids`); the user can swipe to peek at them (read-only) before answering, without leaving the writing surface | User requirement: questions often reference past entries; answering well requires being able to re-read them |

## Decisions made by tech lead (flag if you disagree)

| # | Decision | Notes |
|---|---|---|
| T1 | Rolling-summary cadence: regenerate when **≥7 days since last regen OR ≥5 new entries since last regen** (checked on save), and **always on entry delete** | Deterministic, no timers required — an app that's closed can't run a weekly job, check-on-save covers it |
| T2 | Follow-up Q&A: **max 2**, stored as separate `FollowupResponse` rows (per schema), displayed **inline appended** in Entry Detail | Schema stays as documented; UI presentation is inline |
| T3 | Multi-entry day on calendar: show **latest entry's mood** emoji; day marker regardless | Resolves PRD open question |
| T4 | Safety check: pure deterministic function (`checkCrisisSignal(text) -> matches[]`), curated multi-source phrase list, **dedicated research + review sign-off before ship**; never blocks save | Per docs' caution about ad-hoc lists |
| T5 | KDF choice (PBKDF2 vs Argon2id) **deferred to Phase 2** — the M1 device-key path uses a random non-extractable CryptoKey, no KDF | Export/PIN re-introduce the question |
| T6 | Onboarding-completed flag lives in the `Settings` table (single source of truth), not localStorage | Schema already has the table |
| T7 | State: plain Vue composables; add Pinia only if a real need appears | KISS for a single-user local app |
| T8 | Generic rotating prompt pool: ~10 copywritten non-clinical prompts, deterministic rotation (by entry count), stored as a constant | Copy needs a dedicated pass (see Open questions) |
| T9 | Summary regeneration input budget: last **50 entries** + previous summary themes merged, to keep 657MB-model inference fast as the journal grows | Small journals in M1; revisit later |

## Scope

### In scope (M1)

- **Onboarding** framing screen (what this is / isn't; first-open only)
- **Dashboard**: add-entry CTA, current-month calendar, entry markers, per-day mood emoji
- **New Entry** (journal-first): blank page default, stuck path → tiered prompts (theme-based, else rotating generic pool), 1–2 light follow-ups, mood picker
- **Rolling summary**: generation + cadence regeneration + regen on delete
- **Journal History**: list, detail, delete (delete → regen)
- **Deterministic safety check** on every save, independent of the model flow
- **At-rest encryption**: device-generated key path (AES-GCM, non-extractable CryptoKey)
- **Model integration**: MiniCPM5-1B via wllama, first-run download UX, SW weight caching
- **PWA**: app shell precache, installable, fully offline after first load

### Out of scope (explicitly deferred)

| Item | Lands in |
|---|---|
| PIN lock UI (toggle + unlock screen + PIN-derived key) | M1.1 |
| Export / Import (backup) | Phase 2 |
| Manage Memories screen (view/prune themes) | Phase 2 |
| Reminders | Phase 3 |
| Voice input | Phase 4 |

## Workstreams

Dependencies: `W2 → W4 → W5`, `W2 → W6`, `W3` runs in parallel with `W1/W2`, `W3 → W8 → W9/W10/W11`, `W6 → W11 (summary needs saved entries)`, `W7` needs `W6` (delete → regen needs `W11`).

| # | Workstream | Depends on | Size | Acceptance criteria |
|---|---|---|---|---|
| **W0** | **Design refresh (planning-phase deliverable, not implementation)**: create `docs/example-journal-first.html` — journal-first New Entry (free-write + stuck path + follow-up as aside cards), add Onboarding frame, keep existing design system | — | S | User signs off journal-first direction; tokens/vars unchanged; **no implementation work starts before this sign-off** |

**W0 status — ✅ v4 (final): frame 07 added — swipe-peek: when a follow-up question references a previous entry, the user can swipe down to pull it up for context (read-only, "swipe ↑ to put it away") without leaving the writing surface. All 10 frames render; headless-chrome verified. Sign-off received — proceeding to W1 + W3.**

- `00 Onboarding` — warm framing, is/isn't copy, Continue (reuses aside-card language: sage "what it is", rose "what it isn't")
- `01 Dashboard` — verbatim copy of original
- `02 New Entry (free write)` — dominant Fraunces writing surface (real textarea), meta row, Done button — no chat elements
- `03 New Entry (stuck · generic)` — aside card above textarea: "No pressure" + rotating-pool prompt, chips "Not this one" / "Just a plain page"
- `04 New Entry (stuck · from memory)` — amber aside card: "From your recent entries" + theme-based prompt
- `05 New Entry (follow-up)` — aside card: "One quick thing · 1 of 2", respond row + full-width "Skip — close this out" (skip ≥ respond prominence), mood picker + Save (flow order: Done → follow-up → mood → save)
- `06 History` / `07 Settings` — verbatim copies, renumbered
- Chat-bubble CSS removed; new minimal CSS: `.entry-sheet`, `.aside-card`, `.respond-row`, `.finish-bar`, `.onboard`
| **W1** | **Scaffold**: Vue 3 + Vite + TS, vue-router, vite-plugin-pwa, Dexie, wllama dep; self-host fonts (offline requirement); design tokens from `example.html`; route stubs | W0 sign-off | S | `dev` + `build` work; fonts load offline; PWA plugin configured |

**W1 status — ✅ done.** Vue 3.5 + Vite 8 + TS 5.9 (strict), vue-router 5, vite-plugin-pwa (generateSW, 6-entry app-shell precache), @fontsource self-hosting (zero CDN refs in dist), manifest + SVG icon, 6 views + router with `hideTabbar` meta, `lib/{db,model,safety}` stubs with W2/W6/W8/W11 TODOs, vitest smoke test green. Verified independently: `npm run build` ✅, `npx vitest run` ✅ (1/1), SW + manifest generated.

**Findings (recorded for later workstreams):** (1) the unscoped `wllama` npm package no longer exists (404) — official successor is `@wllama/wllama` (same author/repo), pinned 3.6.0; (2) TypeScript 7 (tsgo) is npm `latest` and breaks vue-tsc — pinned `typescript@^5.9.3`; (3) vue-router resolved to v5.2.0 — core API intact.
| **W2** | **Data layer + crypto**: Dexie schema v1 (`entries`, `followupResponses`, `rollingSummary`, `settings` per data-schema.md); `crypto.ts` — device key generation (non-extractable AES-GCM CryptoKey stored in IndexedDB), encrypt/decrypt envelope (iv + ciphertext); unit tests (roundtrip, tamper detection, key persistence) | W1 | M | Roundtrip tests green; no unencrypted content column |

**W2 status — ✅ APPROVED (Gatekeeper, after one fix round).** Dexie v1 typed schema (camelCase field names — data-schema.md updated to match code), `secrets` table for the device key, AES-GCM 256 non-extractable key with transactionally-serialized cross-tab race closure, envelope = 12-byte IV ‖ ciphertext (fused so the IV can never be lost), descriptive tamper errors. 15/15 vitest tests incl. persistence roundtrip, two-connection race, wrong-key rejection, index/single-row semantics. Build ✅.
| **W3** | **Model spike**: load MiniCPM5-1B Q4_K_M via wllama; measure load time / memory / tok/s on Android Chrome + iOS Safari; quality checklist (generates a gentle follow-up question from an entry + structured theme summary); SW caching of the 657MB GGUF; record numbers in a spike report | W1 (standalone demo page) | M | GO/REWORK gate: 0.5B→1B quality verified, load UX feasible on target devices |

**W3 status — ✅ CONDITIONAL GO (full report: `docs/spike-model.md`).** MiniCPM5-1B Q4_K_M loads/runs via `@wllama/wllama` 3.6.0 end-to-end (standard Llama arch, embedded Jinja template, `enable_thinking` kwargs verified, Apache-2.0). No showstopper. **MiniCPM3-4B fallback NOT needed for M1** (reversible via `wllama-client.ts`). 3 mandatory design conditions + gotchas recorded below.

**Spike conditions (MANDATORY for W8–W11):**
- **C1 (Task B — summary redesign)**: model returns theme phrases only (`{"themes":["..."]}`); `last_mentioned_days_ago` / `mention_count` are computed **app-side in JS** (W11) — the 1B model hallucinates numbers / can't count reliably. Structured output survives; the structure's numerics come from app logic.
- **C2 (Task A — follow-up)**: few-shot example + `temperature: 0.5` + **no-think** (`enable_thinking: false`) + output validator (ends with "?") + 1 retry. At temp 0.7 compliance was only ~60–70%; tuned config passed 2/2 grounded, non-clinical.
- **C3 (offline, CRITICAL)**: wllama 3.6.0 **always** calls `setCompat("default")` → pulls compat assets from the **jsDelivr CDN** on JSPI-less browsers (iOS Safari) — violates the offline PWA requirement. W8 must `npm i @wllama/wllama-compat`, copy its `wasm/` into `public/`, and call `setCompat({ worker, wasm })` with self-hosted paths.

**Gotchas folded into workstreams:** G4 multi-thread WASM needs COOP/COEP headers (W12) · G5 split the GGUF into ≤512 MB chunks (`llama-gguf-split`), `loadModelFromUrl` auto-joins, lowers peak memory + speeds first-run (W8) · G7 peak memory ~2.4 GB desktop; mobile (esp. iOS compat + 657 MB single-file) is the riskiest cell (W12) · G8 response hygiene → shared validator/retry layer (W10–W11) · G6 Node WASM shim recipe exists to CI-test prompts against the real build (W8–W11) · KV-cache reuse makes the 2nd follow-up ~3× faster — W10 should reuse one context session for Q1→Q2.
| **W4** | **Onboarding + app shell**: framing screen (is/isn't), continue → dashboard, gate via Settings flag; router guard | W1 | S | Fresh profile sees onboarding once; reload skips |

**W4 status — ✅ done.** `onboardingCompleted` added to Settings (T6), `settings.ts` (transactional get-or-create + idempotent completeOnboarding), OnboardingView faithful to wireframe frame-00 (scoped styles), `ensureOnboarded` router guard (exempts /onboarding, no loop). 21/21 tests incl. guard redirect/post-completion/no-loop + settings defaults/persistence. Headless-chrome fresh-profile spot-check 6/6. Build ✅.
| **W5** | **Dashboard**: header (title + date), "Add new journal" CTA, month calendar with markers + mood emoji (latest-of-day), month nav, empty state | W2 | M | Saved entries appear with marker + emoji; multi-entry day shows latest emoji |

**W5 status — ✅ done.** Dashboard per wireframe frame-01: header/calendar + quiet ‹ › nav/mood emoji + amber dots/today highlight/Recent rows/empty state/glowing FAB → /entry/new (reduced-motion respected). Read-side repo `src/lib/entries.ts` (only place content is decrypted for UI; `DecryptedEntry` never exposes blobs) + pure `src/lib/calendar.ts` grid helpers (T3 latest-of-day mood via `moodForDay`). 51/51 tests (30 new: grid offsets incl. leap Feb, T3, title/snippet derivation, month/recent ordering against real device-key encryption). Headless-chrome seeded-data pixel-check (header, 5 recent rows, date-fallback title, emoji days, today highlight, FAB, month nav to Jul/Sep). Build ✅.

**Split W6 into W6a (safety check — pure/independent) + W6b (entry UI + save)** per the milestones sequencing note (safety built/tested independently of the model flow).
| **W6** | **Entry write + save + safety check**: journal-first editor (blank textarea, aside cards); Done → mood picker → encrypted save; `safety/crisis-check.ts` pure checker + curated list (dedicated research, review sign-off); crisis resource panel when tripped, never blocks save; unit tests for checker | W2 | M | Entry saves offline + decrypts on read; checker tests green (tripped phrases, negatives, false-positive guard) |

**W6a (safety module) — ✅ APPROVED (Gatekeeper, after 5 rigorous fix rounds).** Each round surfaced a genuine bug class (FP suppression holes → FN over-suppression → Safari-unsafe variable-length lookbehinds → negation/aggregation bugs → rule-anchor gaps). Final: 95/95 tests, zero lookbehinds in shipped source, deterministic, windowed benign-context guards, negation-aware disavowal handling. Human crisis-sign-off (phrase set + guards + resource localization) remains the one shipping gate — tracked in Open questions.

**W6b (entry UI + save) — ✅ APPROVED (Gatekeeper) + should-fix resolved (stuck-state leak on 'keep writing'; save-first ordering made airtight; regression test added).** createEntry is the only encrypted-column writer (verified: no view touches db.entries); journal-first editor (frames 02/03), rotating init pool (T8), Done→mood→save; crisis panel strictly post-commit & dismissible; empty-save/mood guards correct. 122/122 tests, build clean.

**W6 constraint (from W2 gate review):** views must never call `db.entries.add` with raw content — W6 introduces a repository/service layer whose API is plaintext-in / encrypted-out, and it is the only path that writes encrypted columns. Enforce in review.
| **W7** | **History + Entry Detail + delete**: list (title from first/second line, date fallback), detail view (decrypted, follow-ups appended inline), delete with confirm → cascade delete follow-ups + trigger regen | W6 (W11 for regen) | M | List/detail/delete work offline; delete triggers regen |

**W7 status — ✅ APPROVED (Gatekeeper, 1 fix round: double-`re:` CSS duplicate + delete-failure dead-end; Tech-Lead-verified fix delta).** `deleteEntry` atomic cascade (one rw txn across entries+followupResponses, no orphans), regen seam `scheduleSummaryRegeneration('entry-deleted')` called exactly once on success (W11 implements `.catch` once real), repo-only decrypt discipline maintained, inline confirm (no native dialog) with per-row dismissible retry, route-param watch for id→id nav. 146/146 tests, build green (pending W8's final build).
| **W8** | **wllama client + load UX**: `model/wllama-client.ts` — lazy singleton, context assembly (current entry + summary themes + last 1–2 entries); first-run "downloading your private AI" progress UX; SW weight caching with versioned re-fetch | W3 | M | Weights fetched once, cached; second launch fully offline |

**W8 status — ✅ APPROVED (Gatekeeper) + 2 should-fixes resolved by Tech Lead (wasm `?v=` versioning for ABI-safe upgrades; `model:fetch --force` + README).** Lazy idempotent state machine (shared in-flight load, retryable), C3 satisfied (zero CDN — self-hosted primary + compat wasm), C2 config themes (temp 0.2/120 tok) & follow-ups (temp 0.5/60 tok, retry 0.7), SW: app-shell-only precache + CacheFirst runtime caches for /models/ (bounded) & /wasm/ (versioned), model fetch script (SHA-256 verified + split contract, llam-gguf-split not execution-tested → W12 device verification). 170/170 tests, build clean.
| **W9** | **Stuck-path prompts**: "I don't know what to write" → theme-based open question (when summary exists) else rotating generic pool; light aside card, never blocks writing | W8 (W11 for theme path) | S | Stuck path works for new users (generic) and returning users (themed) |
| **W10** | **Follow-up Q&A (opt-in)**: after Done the app asks "Want to talk about this?" — the model **never interjects on its own**. Yes → max 2 gentle follow-ups; the response is written **in the same main writing surface** (delta appended as the `FollowupResponse`), never a cramped input; dismiss ≥ as easy; **swipe-peek at the referenced previous entries** (read-only) before answering. No → straight to mood + save. Persisted encrypted. **Task A config per spike C2** (few-shot + temp 0.5 + validator + retry, no-think); reuse one context session so Q2 benefits from KV-cache reuse | W8 | M | Opt-in gate works; max 2; long responses accommodated; swipe-peek works; dismiss works; persisted encrypted; no chat-thread creep; **non-CBT guardrails enforced (see below)** |

**W10 status — ✅ done (implementation verified; full test suite completed by dedicated test agent after the original W10 agent was cut off mid-work).** That test round caught + fixed TWO critical bugs: (1) Vue-proxy `referencedEntryIds` → IndexedDB DataCloneError (every follow-up save silently failed) — fixed `[...]` at write boundary; (2) `db.entries.update()`/Dexie `modify` mangled the encrypted ArrayBuffer (permanent data loss) — fixed `put({...entry})`. 30 new tests (worthiness, cap 2, encrypted roundtrip, skip→null, validator+1 retry, opt-in flow, delta capture incl. long/stirred-up response, "One more?" gating, swipe-peek, crisis-priority, gate-Now-saves-alone). Non-CBT guardrails verified in the shipped system prompt. 249/249 tests, build clean.
| **W11** | **Rolling summary**: `model/summary.ts` — structured themes JSON `{ topic, lastMentionedDaysAgo, mentionCount }`, encrypted storage; cadence check on save (T1); regen on delete; input budget T9. **Per spike C1**: model outputs `{"themes":["..."]}` theme phrases only; `lastMentionedDaysAgo` / `mentionCount` computed deterministically app-side by matching themes against entry text (W11 owns the matcher) | W6 + W8 | L | Summary generates; cadence honored; delete triggers regen; counts/days accurate (app-computed, tested) |

**W11 status — ✅ APPROVED (Gatekeeper) + should-fix resolved (deferred-delete negative-delta → due).** Matcher (C1) is boolean per-entry, windowed, deterministic, and the ONLY source of the numeric fields; strict JSON parse (fence/dup-key/extra-key rejected, 1 retry, prior preserved); T1 cadence boundaries tested; scheduler never rejects, single-flight, and **deferral guard ensures a save/delete can never silently force-load the 657MB model** (regen runs once the model is ready via a user-visible action); themes encrypted at rest. 218/218 tests + negative-delta test now, build clean.
| **W12** | **PWA hardening + device matrix**: app-shell precache, model cache separation + eviction check (iOS Cache API with 657MB file), installability, airplane-mode pass; Android Chrome + iOS Safari smoke tests | W8 | M | Full offline pass on both platforms; model re-fetched only on version bump |
| **W13** | **Dogfood + acceptance**: daily-use pass against Definition of Done; fix fallout | W12 | S | DoD checklist complete |

Rough total: **4–5 weeks** solo-engineer effort; W3 (model spike) and W11 (summary quality) carry the most uncertainty.

## Non-CBT guardrails (encoded in the model system prompt, verified in W3 spike + W10)

Follow-up questions are reflective, not corrective — and **opt-in**: the model never interjects after writing; the user chooses to be asked ("Want to talk about this?"). The mechanism (a question after writing) is shared with CBT thought records, so the line is drawn in content and intent. These rules are hard constraints:

**Allowed** — open, grounded, curious questions about what the user actually wrote:
- "What made today's attempt click when Monday's didn't?"
- "You mentioned X twice this week — has anything shifted?"

**Banned** — evaluative / corrective / clinical patterns:
- Evidence evaluation: "What's the evidence for/against that thought?"
- Cognitive restructuring: "Is there another way to look at it?", "What would you tell a friend?"
- Distortion vocabulary: catastrophizing, all-or-nothing, mind-reading, should-statements, labeling
- Restructuring language: "reframe", "unhelpful thought", "balanced view", "automatic thought"
- Exercise/homework framing: "try this exercise", "this week's assignment", "practice"
- Interpretation/diagnosis: any phrasing that explains *why* the user feels something

**Tone**: plain, warm, shrug-off-able — the user should never feel assessed. A follow-up they can decline without friction is the whole point.

**Surface**: follow-up responses are written in the same generous writing surface as the entry itself — never a cramped one-line input. A question can stir up a lot; the UI must welcome long responses, and the response is appended to the entry as free writing, not a chat reply.

## Risks

| # | Risk | Mitigation |
|---|---|---|
| R1 | MiniCPM5-1B follow-up/summary quality below bar | W3 spike has explicit quality checklist + fallback decision (MiniCPM3-4B) before any dependent work |
| R2 | wllama load time / memory / tok/s unacceptable on iOS Safari (WASM limits) | W3 measures on real devices; load UX designed around one-time cost; W12 device matrix |
| R3 | 657MB model evicted from SW cache (iOS quota/eviction) | W12 explicit eviction test; fallback: re-fetch with progress UX (data itself never affected — IndexedDB) |
| R4 | Safety keyword list wrong (false positives or missed signals) | Dedicated research with sources; conservative phrase-combos; review sign-off; checker is isolated + unit-tested |
| R5 | Model output drifts into clinical/chatty register | Prompt system constraints: gentle, non-clinical, non-diagnostic; quality checklist covers it; capped follow-ups |
| R6 | Crypto retrofit if schema changes post-launch | Dexie versioning from day one; W2 ships before any real data exists (per sequencing note in milestones.md) |

## Open questions (tracked, non-blocking)

- Exact onboarding + generic prompt pool copy → copywriting pass in W0/W9
- `mood_emoji` plaintext — accepted v1 simplification (calendar rendering without decrypt pass); revisit in Phase 2
- **Safety phrase set + resource localization — HUMAN SIGN-OFF REQUIRED before M1 ships (W6a flagged):** phrase set/guards (esp. the narrow "want to die"/"kill myself" hyperbole guard and the "suicide" prevention-grief guard) need someone with crisis-line/mental-health expertise to review; resource numbers/copy need market-by-market verification. W6b may wire the panel in, but ship is gated on this.
- ~~MiniCPM5 license confirm~~ → **resolved: Apache-2.0 (W3 spike)**
- ~~Model size / load time~~ → **resolved by W3 spike** (657 MB Q4_K_M confirmed; load 4–8 s desktop, tok/s recorded; *device* matrix still W12)
- ~~Fill: model load UX feasibility before committing~~ → **spike says viable with conditions; first-run UX sized by W8**

## Definition of Done — Milestone 1

1. Fresh install → onboarding → dashboard → write entry (free + stuck paths) → mood → save (encrypted at rest)
2. Entry appears on calendar + history immediately; readable on reopen
3. Follow-up: **opt-in gate after Done** ("Want to talk about this?"); if accepted, max 2 gentle questions, dismissal ≥ as easy as responding, swipe-peek at referenced entries, persisted encrypted
4. Stuck path: themed prompt when history exists, generic pool otherwise
5. Safety check fires on tripped phrases → resource panel, save never blocked; unit tests green
6. Rolling summary regenerates on cadence + on delete
7. After first load, airplane-mode run works end-to-end (app shell + model + data all local)
8. Model cached; re-fetched only on version bump
9. Critical-path unit tests green: crypto roundtrip/tamper, safety checker, summary cadence logic
10. Device matrix smoke test: Android Chrome + iOS Safari (PWA install)

## Suggested execution order

1. **W0 design refresh (planning phase)** — journal-first `example.html` produced now, user reviews, sign-off gates implementation
2. W1 + W3 (parallel) → W2 → W4 → W5 → W6 → W7/W8 → W9/W10 → W11 → W12 → W13.
