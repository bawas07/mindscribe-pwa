# MindScribe (Reflective Journal PWA) — PRD

> Working name — swap in whatever you land on for Bawa Lab branding.

## Problem

Most journaling apps are either a blank page (hard for beginners who don't know what to write) or a clinical CBT tool (feels like homework, and implies a level of therapeutic rigor a general-purpose app shouldn't claim). Meanwhile, reflective writing about private thoughts is exactly the kind of data people don't want sitting on a third-party server. There's no local-first, beginner-friendly journaling companion that gently helps someone get unstuck and remembers their patterns over time — without pretending to be a therapist or requiring an internet connection.

## Goals

- Text-only, fully offline PWA — journaling works with zero network dependency after first install
- Lower the barrier to writing for beginners: gentle opening prompts and light follow-up questions when someone doesn't know what to write
- Build a private, persistent sense of "being known" over time via a local memory/pattern layer — without ever sending journal content off-device
- Journal-primary, not chat-primary: the written entry is the artifact; the model's role is a light nudge, not a conversation partner
- Explicitly avoid clinical/CBT framing and diagnostic language — position as a reflective companion, not a mental health tool
- Data stays encrypted at rest by default, with user-controlled, genuinely offline backup/restore

## Non-goals

- Not a CBT or therapy tool — no distortion-taxonomy jargon, no diagnostic claims, no clinical positioning
- Not a full conversational chatbot — no multi-turn open-ended chat threads
- No cloud sync in v1 — no account system, no server component at all
- No automatic mood/sentiment inference from text — mood is user-selected, not model-inferred
- No voice/audio input in this phase (explicitly deferred — see Out-of-scope)
- No video-based or pose-estimation features

## Target users / roles

Single-role product — no multi-user/permission system.

- **Journaler**: an individual using the app privately on their own device. Primary need: a low-friction way to write, get gently unstuck when blank, and see their own patterns over time — with confidence that the content never leaves their device.

## Core features

### Onboarding / entry framing
- **What**: First-open screen states plainly what this is (a reflective writing companion) and isn't (therapy, diagnosis, crisis support)
- **Why**: Sets honest expectations up front rather than as a buried disclaimer; supports the "MindScribe, not clinician" positioning
- **Key requirements**:
  - Warm, one-time framing screen (not a legal wall of text)
  - Points to real crisis resources contextually if the safety-check ever fires (see below), not preemptively dumped here
- **Open questions**: exact copy TBD

### Dashboard
- **What**: Home screen — add new journal entry, month calendar with entry markers, per-day mood emoji
- **Why**: Gives a lightweight sense of consistency/history without being a guilt-inducing streak tracker
- **Key requirements**:
  - "Add new journal" primary action
  - Current-month calendar view; days with an entry are marked
  - Mood emoji shown per day, based on a mood the user picks when finishing an entry (not model-inferred)
- **Open questions**: what happens with multiple entries in one day — show one emoji (latest? first?) or a stacked indicator?

### Journal entry flow (core loop)
- **What**: Free-write entry, with optional gentle assistance for beginners and blank-page moments
- **Why**: This is the actual product — writing is the mechanism, the model is scaffolding, not the point
- **Key requirements**:
  - Blank page by default — no forced prompt
  - If user writes freely: after finishing, model may offer **one, at most two**, light follow-up questions (not a chat thread); user can respond (appended to entry) or decline and close out
  - If user says "I don't know what to write": tiered fallback —
    1. Pull rolling summary + recent/recurring themes (recent + mentioned multiple times, not just "heaviest" thing in history) and phrase an open, non-presumptuous question around it (e.g. "has anything shifted with X?")
    2. If no meaningful history yet (new user / thin data): fall back to a rotating pool of generic, non-clinical opening prompts ("anything stand out about today?", "what's been taking up headspace lately?")
  - User always picks a mood emoji when finishing an entry
  - Entry saved locally, encrypted at rest (see Data entities / security notes)
- **Open questions**: exact rotating prompt pool copy; whether follow-up responses get appended inline or as a separate linked block

### Memory / rolling summary layer
- **What**: Lightweight, periodically-regenerated summary of recurring themes across entries — not raw entry recall, not a full-archive dump into every model call
- **Why**: Lets the model act like it "remembers" without re-processing the whole journal every session; keeps inference fast and context small
- **Key requirements**:
  - Structured, not prose-only — e.g. `{ topic, last_mentioned_days_ago, mention_count }` per theme, so fallback prompt selection (recent + recurring) can be done deterministically rather than the model freely rummaging through everything
  - Regenerates on a schedule (e.g. weekly or every N entries), not on every single save — cost/freshness tradeoff, exact cadence TBD
  - Deleting an entry triggers **regeneration from remaining entries**, not a targeted per-entry memory delete (there's no clean 1:1 mapping between entries and summary themes)
- **Open questions**: exact regeneration cadence; summary size/token budget ceiling

### Journal history
- **What**: List of past entries, view/delete
- **Why**: Lets users revisit or prune their own history
- **Key requirements**:
  - Title derived from first/second line of entry; fallback to date-based title if entry is too short or is just the echoed opening prompt
  - Delete removes the entry and triggers rolling-summary regeneration (see above)
- **Open questions**: none major

### Safety check (deterministic, not model-based)
- **What**: A separate, non-LLM keyword/pattern check that runs on every entry save
- **Why**: Small local models are not reliable enough to be trusted as the sole safety net for catching crisis signals — this needs to be dumb and reliable, not clever and probabilistic
- **Key requirements**:
  - Runs independently of the CBT-adjacent/follow-up flow — always fires regardless of what else is happening
  - If tripped, surfaces crisis resources directly in the UI
  - Does not block or alter the journaling flow itself beyond surfacing that resource panel
- **Open questions**: exact keyword/pattern list and source (needs care — this should probably get dedicated research/review rather than an off-the-cuff list)

### Reminders
- **What**: Optional local notification to prompt journaling, start-of-day or end-of-day
- **Why**: Supports habit-building for a tool that gets more useful with consistent use
- **Key requirements**:
  - User-configurable time, start-of-day vs end-of-day framing
  - Requires validating actual PWA local-notification reliability on target platforms (iOS Safari PWA notification support has historically been inconsistent) before committing to this as a hard v1 feature
- **Open questions**: fallback UX if reliable local notifications aren't achievable on a target platform

### Manage memories (settings)
- **What**: User-facing view of the rolling-summary themes, with delete capability
- **Why**: Trust feature — since the app's pitch rests on "it remembers you," users should be able to see and prune exactly what that means
- **Key requirements**:
  - List of current themes/topics tracked in the rolling summary
  - Delete a theme → removed from summary (does not delete underlying entries)
- **Open questions**: none major

### PIN lock (optional, settings)
- **What**: Optional app-unlock PIN, toggle on/off
- **Why**: Local access-gating for a shared/family device scenario; explicitly optional to keep the entry barrier low
- **Key requirements**:
  - Off by default
  - When enabled, gates app open with a PIN
  - Data is encrypted at rest regardless of whether PIN is enabled — PIN gates *access*, encryption key derivation is a separate concern (device-generated key when PIN is off, PIN-derived when on)
- **Open questions**: PIN length/complexity for app-unlock (separate decision from the 6-digit export PIN below)

### Export / Import (backup)
- **What**: Manual export to a local file the user holds; import to restore on a new device
- **Why**: Local-only storage means device loss = total data loss without this — treated as non-negotiable for a local-first tool
- **Key requirements**:
  - At export time, user is asked: "Protect this backup with a PIN?"
    - **Yes** → 6-digit PIN (may reuse app-unlock PIN if set, or choose a new one specific to export) → file encrypted with a key derived from that PIN (PBKDF2/Argon2-class KDF, meaningful iteration count)
    - **No** → plain unencrypted export, clearly labeled in-UI as unprotected — an explicit, informed choice, not a silent default
  - Export file includes a flag indicating whether it's PIN-protected, so import knows whether to prompt
  - Import: prompts for PIN if the file is flagged protected, decrypts, restores; wrong PIN gives a clear retry (no lockout needed — local file operation, not a live auth endpoint)
  - UI copy makes clear: if a PIN is forgotten, the backup is unrecoverable — no server-side reset path exists in a local-first/zero-knowledge design
- **Open questions**: exact KDF + iteration count; file format (JSON envelope assumed)

## Data entities (high level)

- **Entry**: a single journal entry — raw text, created_at, mood emoji, optional follow-up Q&A appended
- **RollingSummary**: structured, periodically-regenerated theme list derived from entries — not a 1:1 record per entry
- **Settings**: PIN-enabled flag, reminder config, last export timestamp, model/app version

Full schema lives in the BE doc.

## Out-of-scope / future considerations

- **Phase 2: voice input** — same model family (see BE doc for the omni vs text-only model decision made for this phase), mic input feature-flagged on later rather than requiring a model swap
- Cloud sync / multi-device without manual export-import
- Any model-based mood inference from entry text (deliberately rejected — user-selected mood is the source of truth)
- Any clinical/CBT-branded framing, distortion tagging exposed to the user, or diagnostic language
- Vision input (e.g. photo-based journaling) — not discussed for this product, no current plan
