/**
 * Rolling summary — W11.
 *
 * A lightweight, structured list of recurring themes, periodically
 * regenerated and stored encrypted (docs/data-schema.md: rollingSummary —
 * the themes blob is encrypted; generatedAt / sourceEntryCount are
 * plaintext). Per spike condition C1, the 1B model supplies theme phrases
 * only (`{"themes":["..."]}`, spike §5 Task B); the numeric fields are
 * computed app-side by the exact word-overlap matcher (./themes.ts).
 *
 * Cadence (decision T1): regenerate when >=7 days since the last summary OR
 * >=5 new entries since it was generated — checked on save — and ALWAYS on
 * entry delete. Input budget (decision T9): the last 50 entries + the
 * previous summary's theme phrases for continuity.
 *
 * The model is optional scaffolding in the same spirit as W8/W9/W10: a
 * failed or unavailable model never blocks the journal. Regeneration is
 * fire-and-forget and never rejects — every failure is logged and the
 * previous summary is kept intact (never a broken/empty row).
 */
import { countEntries, listRecentEntries } from '../entries'
import type { DecryptedEntry } from '../entries'
import { db, ROLLING_SUMMARY_ROW_ID, type RollingSummary } from '../db/schema'
import { decryptText, encryptText, getOrCreateDeviceKey } from '../db/crypto'
import { matchThemesToEntries, wholeDaysAgo, type Theme } from './themes'
import { modelClient } from './wllama-client'

/** Why a regeneration was requested (plan decision T1). */
export type SummaryTrigger = 'save' | 'entry-deleted'

/** T1: regenerate when at least this many whole days have passed since the last summary. */
export const SUMMARY_REGENERATION_DAYS = 7
/** T1: regenerate when at least this many new entries were added since the last summary. */
export const SUMMARY_REGENERATION_NEW_ENTRIES = 5
/** T9: input budget — only the most recent N entries feed the model. */
export const SUMMARY_INPUT_BUDGET = 50
/** Spike §5/G8: malformed themes output gets 1 retry (2 total attempts). */
const MAX_THEMES_ATTEMPTS = 2

/**
 * Single-flight guard for the fire-and-forget regen. While one regeneration
 * is in flight, additional schedule requests are coalesced into it — a regen
 * takes seconds (model call), and the next save-cadence check or delete
 * re-triggers afterwards, so stacking concurrent regens buys nothing.
 */
let regenerationInFlight: Promise<void> | null = null

/**
 * W11 entry point — fire-and-forget, never rejects.
 *
 * For 'save' the cadence (T1) is checked first and regen runs only when due
 * (or when no summary exists yet). For 'entry-deleted' regen always runs.
 * Every failure is caught and logged here, so callers can `void` this safely
 * (W7 gate note) and a summary failure can never surface as an unhandled
 * rejection to the UI.
 */
export async function scheduleSummaryRegeneration(trigger: SummaryTrigger): Promise<void> {
  try {
    // Never force the model to download in the background just to build a
    // summary — the model loads ONLY on user-visible actions (W8 design:
    // the "downloading your private AI" sheet is surfaced by ModelGate, not
    // silently by a save). If it isn't already loaded, defer: the cadence
    // state persists, and the next save/delete once the model IS ready
    // (e.g. after the follow-up or stuck-themed flow loaded it) regenerates.
    if (modelClient.getModelStatus().state !== 'ready') return

    if (trigger === 'save') {
      if (!(await isSaveRegenerationDue())) return
    }
    if (regenerationInFlight) return
    regenerationInFlight = runRegeneration(trigger)
    await regenerationInFlight
  } catch (error) {
    console.error('Rolling summary regeneration failed:', error)
  }
}

async function runRegeneration(trigger: SummaryTrigger): Promise<void> {
  try {
    await regenerateSummary(trigger)
  } finally {
    regenerationInFlight = null
  }
}

/**
 * Regenerates and persists the rolling summary from the current journal
 * state. Never throws: a failed regen is non-fatal (logged; the previous
 * summary stays intact — the journal never depends on the summary). `now`
 * defaults to the current time and is injectable for deterministic tests;
 * both triggers regen from the same current state.
 */
export async function regenerateSummary(trigger: SummaryTrigger, now: Date = new Date()): Promise<void> {
  void trigger // informational: save and delete both regen from current state
  try {
    const entries = await listRecentEntries(SUMMARY_INPUT_BUDGET)
    if (entries.length === 0) {
      // Empty journal: no summary can exist — clear any stale row so
      // getThemes() returns [] (regen-on-delete of the last entry).
      await db.rollingSummary.clear()
      return
    }

    const priorTopics = await readPriorTopics()
    const themes = await computeThemes(entries, priorTopics, now)
    if (themes.length === 0) {
      console.warn('[rolling-summary] no usable themes this run; keeping the previous summary')
      return
    }

    const key = await getOrCreateDeviceKey()
    const themesEncrypted = await encryptText(key, JSON.stringify(themes))
    await db.rollingSummary.put({
      id: ROLLING_SUMMARY_ROW_ID,
      generatedAt: now.toISOString(),
      themesEncrypted,
      sourceEntryCount: entries.length,
    })
  } catch (error) {
    console.error('Rolling summary regeneration failed; keeping the previous summary:', error)
  }
}

/**
 * Theme generation with the spike §5 contract: strict JSON
 * `{"themes":["..."]}`, validated with up to 1 retry, never letting the
 * model's numbers (or noise) through. Returns the matched themes, or [] on
 * failure/hallucination so the caller keeps the prior summary.
 */
async function computeThemes(
  entries: readonly DecryptedEntry[],
  priorTopics: string[],
  now: Date,
): Promise<Theme[]> {
  const context = buildThemesContext(entries, priorTopics, now)

  for (let attempt = 1; attempt <= MAX_THEMES_ATTEMPTS; attempt++) {
    let raw: string
    try {
      raw = await modelClient.generateThemes(context)
    } catch (error) {
      // Model unavailable (not downloaded / load failed) — non-fatal.
      console.error(`[rolling-summary] theme generation failed (attempt ${attempt}):`, error)
      continue
    }

    const topics = parseThemesOutput(raw)
    if (!topics) {
      console.warn(`[rolling-summary] malformed themes output (attempt ${attempt}): ${raw.slice(0, 200)}`)
      continue
    }

    // The model owns topic naming; the matcher owns the numbers (C1). Drop
    // topics that don't actually appear in the entries (model noise / leaked
    // example terms) so only real themes are persisted.
    const matched = matchThemesToEntries(topics, entries, now).filter((theme) => theme.mentionCount > 0)
    if (matched.length > 0) return matched

    console.warn(`[rolling-summary] themes matched no entries (attempt ${attempt}); retrying`)
  }
  return []
}

/**
 * Builds the Task B user message (spike §5): one "RECENT (N days ago)" line
 * per entry (T9 budget) plus the previous summary's topics merged in for
 * continuity. The system prompt (wllama-client.ts) supplies the strict JSON
 * contract, grounded example and fence/key bans.
 */
function buildThemesContext(
  entries: readonly DecryptedEntry[],
  priorTopics: readonly string[],
  now: Date,
): string {
  const entryLines = entries.map(
    (entry) => `RECENT (${wholeDaysAgo(entry.createdAt, now)} days ago): ${entry.content}`,
  )
  const priorLine =
    priorTopics.length > 0
      ? `Previously recurring themes: ${priorTopics.join(', ')}.\nInclude any that still recur below; drop the ones that no longer appear.\n\n`
      : ''
  return priorLine + entryLines.join('\n')
}

/**
 * Strict parser for the model's themes JSON (spike §5/G8). Accepts only a
 * plain object with a single string[] `themes` key; strips code fences as a
 * defensive normalization (the model emits them despite the prompt ban) and
 * rejects duplicate-key output (the observed `{"themes":[...],"themes":[...]}`
 * leak bug). Returns the trimmed non-empty topics, or null when malformed.
 */
export function parseThemesOutput(raw: string): string[] | null {
  const cleaned = stripCodeFences(raw)
  // Duplicate-key guard: counts quoted "themes" keys in the raw text.
  if (cleaned.split('"themes"').length - 1 > 1) return null

  let parsed: unknown
  try {
    parsed = JSON.parse(cleaned)
  } catch {
    return null
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
  const keys = Object.keys(parsed)
  if (keys.length !== 1 || keys[0] !== 'themes') return null

  const themes = (parsed as { themes: unknown }).themes
  if (!Array.isArray(themes)) return null
  const topics = themes
    .filter((topic): topic is string => typeof topic === 'string' && topic.trim().length > 0)
    .map((topic) => topic.trim())
  return topics.length > 0 ? topics : null
}

/** Strips a leading/trailing ```json / ``` code fence if the model wrapped the JSON. */
function stripCodeFences(raw: string): string {
  const trimmed = raw.trim()
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/)
  return fenced ? fenced[1] : trimmed
}

/** Pure cadence decision (decision T1) — tested directly. */
export function isRegenerationDue(
  now: Date,
  lastGeneratedAt: string | null,
  sourceEntryCount: number,
  currentCount: number,
): boolean {
  // No summary yet — generate one.
  if (lastGeneratedAt === null) return true
  if (wholeDaysAgo(lastGeneratedAt, now) >= SUMMARY_REGENERATION_DAYS) return true
  // >=5 new entries since the summary. A NEGATIVE delta also counts as due:
  // entries were deleted since the summary (delete may have been deferred while
  // the model was unloaded), and a stale summary would otherwise linger until
  // the 7-day rule — treat removal as staleness (W11 gate should-fix).
  if (currentCount - sourceEntryCount >= SUMMARY_REGENERATION_NEW_ENTRIES) return true
  if (currentCount < sourceEntryCount) return true
  return false
}

/** Save-trigger cadence: due when there is no summary, it is old, or >=5 new entries. */
async function isSaveRegenerationDue(now: Date = new Date()): Promise<boolean> {
  const summary = await latestSummary()
  if (!summary) return true
  const currentCount = await countEntries()
  return isRegenerationDue(now, summary.generatedAt, summary.sourceEntryCount, currentCount)
}

/** The most recently generated summary row, if any. */
async function latestSummary(): Promise<RollingSummary | undefined> {
  const rows = await db.rollingSummary.toArray()
  if (rows.length === 0) return undefined
  return rows.sort((a, b) => b.generatedAt.localeCompare(a.generatedAt))[0]
}

/**
 * W9 seam — decrypted fresh read of the rolling summary's themes (sorted
 * most-recent first). Returns [] cleanly when no summary exists yet or the
 * row is corrupt/unreadable; W9 feeds the result to pickPromptTheme.
 */
export async function getThemes(): Promise<Theme[]> {
  const summary = await latestSummary()
  if (!summary) return []
  try {
    return await decryptSummaryThemes(summary)
  } catch (error) {
    console.error('[rolling-summary] failed to decrypt themes:', error)
    return []
  }
}

/** Decrypted theme list from a summary row — shape-validated, never throws structure errors. */
async function decryptSummaryThemes(summary: RollingSummary): Promise<Theme[]> {
  const key = await getOrCreateDeviceKey()
  const parsed: unknown = JSON.parse(await decryptText(key, summary.themesEncrypted))
  if (!Array.isArray(parsed)) return []
  return parsed.filter(isTheme)
}

/** Shape guard for entries stored in a summary's themes blob. */
function isTheme(value: unknown): value is Theme {
  if (typeof value !== 'object' || value === null) return false
  const theme = value as Record<string, unknown>
  return (
    typeof theme.topic === 'string' &&
    typeof theme.lastMentionedDaysAgo === 'number' &&
    typeof theme.mentionCount === 'number'
  )
}

/** Prior summary's topics, for continuity (T9). Empty when none readable. */
async function readPriorTopics(): Promise<string[]> {
  const summary = await latestSummary()
  if (!summary) return []
  try {
    return (await decryptSummaryThemes(summary)).map((theme) => theme.topic)
  } catch (error) {
    console.warn('[rolling-summary] could not read previous themes for continuity:', error)
    return []
  }
}
