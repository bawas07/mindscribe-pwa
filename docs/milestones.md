# MindScribe (Reflective Journal PWA) — Milestones

This reflects planning-time assumptions as of this brainstorm — revisit once Phase 1 ships and you have real usage (or your own daily-use) to react to.

## Phase 1 — Core loop

**Goal**: prove the core loop works end-to-end, fully offline, on-device — write an entry, get gently unstuck when needed, see it on the dashboard, come back to it later. This is the minimum that validates the actual product idea (local-first reflective companion), not a stripped placeholder.

**Includes**:
- Onboarding framing screen
- Dashboard: add entry, month calendar, mood emoji markers
- New Entry flow: free write, blank-page fallback prompts, 1-2 light follow-ups, mood picker
- Rolling summary: generation + regeneration (scheduled + on-delete)
- Journal History: list, view, delete
- Deterministic safety check on every save
- At-rest encryption (device-generated key path — PIN lock can ship in the same phase or slip to 1.1, see below)
- MiniCPM4 + wllama integration, model weight caching via service worker

**Explicitly deferred**:
- PIN lock UI (encryption itself is in scope from day one; the *optional PIN toggle* is a smaller add that could slip to Phase 1.1 if it helps ship faster — flagging as a judgment call, not a hard cut)
- Export/Import
- Reminders
- Manage Memories UI (the summary itself is in scope; the settings screen to view/prune it is deferable since it's a trust/transparency feature, not core-loop-blocking)

## Phase 2 — Trust & portability

**Goal**: make the local-first promise actually trustworthy and durable — users can see what the app "remembers," and their data survives a device change.

**Includes**:
- Manage Memories screen
- Export (with optional PIN protection, per the decoupled-key design)
- Import
- PIN lock, if not already shipped in 1.1

**Depends on**: Phase 1's encryption/key architecture must be settled and stable before building export/import re-keying on top of it — this is not a good place to be redesigning the crypto layer mid-flight.

## Phase 3 — Habit support

**Goal**: support consistency without nagging.

**Includes**:
- Reminders (start/end of day), pending the PWA notification reliability check flagged in Architecture/Frontend docs

**Depends on**: a fallback plan if reliable local notifications aren't achievable on a target platform (e.g. iOS Safari PWA) — needs to be resolved before this phase is considered "includable" rather than "attempted."

## Phase 4 (future) — Voice input

**Goal**: the originally-discussed Phase 2 idea (voice) from the PRD's Out-of-scope section — kept as a later phase here since Phase 1-3 above are all still text-only scope.

**Includes**:
- Mic input, likely requiring a model swap or move to the omni MiniCPM line (see Architecture doc's open note on this tradeoff)

**Depends on**: Phases 1-3 stable; a deliberate decision on model strategy for voice, not a default carry-over assumption.

## Sequencing notes

- Data schema + encryption design (Architecture + Data Schema docs) must be finalized before any entry-writing UI is built — this is the one piece that's genuinely painful to retrofit once real user data exists in the wild.
- Rolling summary logic depends on having entries to summarize — build entry CRUD first, summary generation second, even within Phase 1.
- The deterministic safety check should be built and tested independently of the model-based follow-up flow — it's a separate, simpler system and shouldn't get entangled with LLM integration work or blocked by it.

## Out of scope (long-term)

- Cloud sync / multi-device without manual export-import
- Model-based mood inference (deliberately rejected, not just deferred)
- Any clinical/CBT-branded framing or diagnostic language
- Vision input / photo-based journaling
