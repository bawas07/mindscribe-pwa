/**
 * Entry repository — read side (W5, plaintext-out) and write side
 * (W6b, plaintext-in / encrypted-out).
 *
 * The ONLY module that touches encrypted columns: views receive decrypted
 * DecryptedEntry records, hand createEntry plaintext, and never call
 * db.entries directly (W6 constraint from the W2 gate review). Encryption
 * happens here and only here, so no view can accidentally persist raw text.
 */
import { db, type Entry } from './db/schema'
import { decryptText, encryptText, getOrCreateDeviceKey } from './db/crypto'
import { formatDateTitle, formatMonthLabel } from './calendar'
import { scheduleSummaryRegeneration } from './model/summary'

const TITLE_MAX_LENGTH = 60
/** Below this, a first line isn't a meaningful title — fall back to the date. */
const TITLE_MIN_LENGTH = 4
const SNIPPET_MAX_LENGTH = 160
const DEFAULT_RECENT_LIMIT = 5

/** Stable id of a saved entry; plaintext, safe for views and keys. */
export type EntryId = string

/** Entry as views see it: decrypted content, never the raw encrypted blob. */
export interface DecryptedEntry {
  id: string
  createdAt: string
  moodEmoji: string
  hasFollowup: boolean
  content: string
}

function truncate(text: string, maxLength: number): string {
  return text.length <= maxLength ? text : `${text.slice(0, maxLength)}…`
}

/** Decrypts a batch of rows in-memory with the device key. */
async function decryptEntries(rows: Entry[]): Promise<DecryptedEntry[]> {
  const key = await getOrCreateDeviceKey()
  return Promise.all(
    rows.map(async (row) => ({
      id: row.id,
      createdAt: row.createdAt,
      moodEmoji: row.moodEmoji,
      hasFollowup: row.hasFollowup,
      content: await decryptText(key, row.contentEncrypted),
    })),
  )
}

/** Number of saved entries — seeds the stuck-prompt rotation (decision T8). */
export async function countEntries(): Promise<number> {
  return db.entries.count()
}

/**
 * Write side (W6b): saves one entry, plaintext in — encrypted at rest.
 *
 * Trims the content, encrypts it with the device key, and writes the row
 * inside a readwrite transaction. The key fetch and encrypt run BEFORE the
 * transaction because Web Crypto promises must not be awaited inside a
 * Dexie transaction (same rule as crypto.ts). This is the only path that
 * writes entry content — follow-up responses (hasFollowup) belong to W10.
 */
export async function createEntry(input: { content: string; moodEmoji: string }): Promise<EntryId> {
  const content = input.content.trim()
  if (content.length === 0) {
    throw new Error('Cannot save an empty entry')
  }

  const id = crypto.randomUUID()
  const key = await getOrCreateDeviceKey()
  const contentEncrypted = await encryptText(key, content)

  await db.transaction('rw', db.entries, async () => {
    await db.entries.add({
      id,
      createdAt: new Date().toISOString(),
      contentEncrypted,
      moodEmoji: input.moodEmoji,
      hasFollowup: false,
    })
  })
  // W11 save-cadence seam (plan T1): a save may make the rolling summary due
  // (>=7 days since it was generated or >=5 new entries since). Fire-and-forget
  // — summary.ts checks the cadence itself and catches every failure, so this
  // can never block the save return or reject it.
  void scheduleSummaryRegeneration('save')
  return id
}

/**
 * Entries whose createdAt falls in the given local month (month is
 * 0-based), newest first, decrypted. Uses the createdAt index.
 */
export async function listMonthEntries(year: number, month: number): Promise<DecryptedEntry[]> {
  const monthStart = new Date(year, month, 1)
  const monthEnd = new Date(year, month + 1, 0, 23, 59, 59, 999)

  const rows = await db.entries
    .where('createdAt')
    .between(monthStart.toISOString(), monthEnd.toISOString())
    .toArray()

  return decryptEntries(rows.reverse())
}

/** Newest entries first, decrypted. Default limit matches the dashboard's Recent section. */
export async function listRecentEntries(limit: number = DEFAULT_RECENT_LIMIT): Promise<DecryptedEntry[]> {
  const rows = await db.entries.orderBy('createdAt').reverse().limit(limit).toArray()
  return decryptEntries(rows)
}

/**
 * Title from the first non-empty line, trimmed to ~60 chars (plan W7:
 * "title from first/second line, date fallback"). Entries without a
 * meaningful first line fall back to a date-based title, e.g. "17 August".
 */
export function deriveTitle(content: string, createdAt: string): string {
  const firstLine = content
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.length > 0)

  if (firstLine && firstLine.length >= TITLE_MIN_LENGTH) {
    return truncate(firstLine, TITLE_MAX_LENGTH)
  }
  return formatDateTitle(createdAt)
}

/** First ~160 chars with whitespace collapsed — sized for the 2-line clamp. */
export function deriveSnippet(content: string): string {
  return truncate(content.replace(/\s+/g, ' ').trim(), SNIPPET_MAX_LENGTH)
}

/**
 * Mood emoji for a calendar day (plan decision T3): when a day has
 * multiple entries, the latest entry's mood wins. Returns null when
 * the day has no entries or its latest entry was saved without a mood.
 *
 * Entries are expected to be month-scoped (as listMonthEntries returns
 * them) — the day comparison is day-of-month only.
 */
export function moodForDay(entries: readonly DecryptedEntry[], dayOfMonth: number): string | null {
  const onThatDay = entries.filter((entry) => new Date(entry.createdAt).getDate() === dayOfMonth)
  if (onThatDay.length === 0) return null

  const latest = onThatDay.reduce((newest, entry) =>
    entry.createdAt > newest.createdAt ? entry : newest,
  )
  return latest.moodEmoji || null
}

/* ------------------------------------------------------------------ */
/* W7 — History list, detail, delete. Read side stays plaintext-out;   */
/* delete is the only W7 write and touches no encrypted columns.       */
/* ------------------------------------------------------------------ */

/** One entry by id, decrypted, or undefined when it doesn't exist (W7 detail view). */
export async function getEntry(id: EntryId): Promise<DecryptedEntry | undefined> {
  const row = await db.entries.get(id)
  if (!row) return undefined
  const [decrypted] = await decryptEntries([row])
  return decrypted
}

/**
 * One History row: everything the list renders, derived once per entry.
 * Deliberately excludes the full content — the list must not carry (or
 * re-decrypt) bodies it only needs a title and snippet from.
 */
export interface EntrySummary {
  id: string
  createdAt: string
  moodEmoji: string
  hasFollowup: boolean
  title: string
  snippet: string
}

/** Entries of one month, newest first, under the wireframe's month label. */
export interface MonthlyEntryGroup {
  /** e.g. "August 2026" — formatMonthLabel (calendar.ts). */
  monthLabel: string
  entries: EntrySummary[]
}

/**
 * All entries grouped by month, newest month first (wireframe frame 08).
 * One decrypt pass per row (via decryptEntries), then title/snippet are
 * derived exactly once — no over-decrypting, no full bodies in the list.
 */
export async function listEntrySummaries(): Promise<MonthlyEntryGroup[]> {
  const rows = await db.entries.orderBy('createdAt').reverse().toArray()
  const decrypted = await decryptEntries(rows)

  const groups = new Map<string, MonthlyEntryGroup>()
  for (const entry of decrypted) {
    const date = new Date(entry.createdAt)
    // Month key is year+month; insertion order follows the newest-first
    // row order, so months stay newest-first and entries within a group
    // stay newest-first without an extra sort.
    const monthKey = `${date.getFullYear()}-${date.getMonth()}`
    let group = groups.get(monthKey)
    if (!group) {
      group = { monthLabel: formatMonthLabel(date.getFullYear(), date.getMonth()), entries: [] }
      groups.set(monthKey, group)
    }
    group.entries.push({
      id: entry.id,
      createdAt: entry.createdAt,
      moodEmoji: entry.moodEmoji,
      hasFollowup: entry.hasFollowup,
      title: deriveTitle(entry.content, entry.createdAt),
      snippet: deriveSnippet(entry.content),
    })
  }
  return [...groups.values()]
}

/**
 * Follow-up Q&A as the detail view renders it (decision T2: appended
 * inline). Returns an empty array when the entry has no follow-ups — the
 * graceful seam for W10, which doesn't write any rows until M1 ships it.
 */
export interface DecryptedFollowup {
  id: string
  /** The model's follow-up question, decrypted. */
  question: string
  /** The user's free-written response, decrypted; null when unanswered. */
  response: string | null
  /** Ids of entries the question was grounded in (plaintext — swipe-peek). */
  referencedEntryIds: string[]
}

/** Decrypts the follow-up Q&A of one entry; empty array when there is none. */
export async function listFollowupsForEntry(entryId: EntryId): Promise<DecryptedFollowup[]> {
  const rows = await db.followupResponses.where('entryId').equals(entryId).toArray()
  if (rows.length === 0) return []

  // Inline Q1→Q2 order by their persistence timestamp (W10); rows written
  // before createdAt existed (fallback '') keep their insertion order.
  rows.sort((a, b) => (a.createdAt ?? '').localeCompare(b.createdAt ?? ''))

  const key = await getOrCreateDeviceKey()
  return Promise.all(
    rows.map(async (row) => ({
      id: row.id,
      question: await decryptText(key, row.questionEncrypted),
      response: (await decryptText(key, row.responseEncrypted)).trim() || null,
      referencedEntryIds: row.referencedEntryIds,
    })),
  )
}

/**
 * W7 delete: removes the entry AND its follow-up responses in one
 * readwrite transaction (cascade via the entryId index, per
 * docs/data-schema.md). Throws on a missing id so a caller can never
 * mistake a silent no-op for success. No crypto is awaited inside the
 * transaction (same rule as crypto.ts), and countEntries stays
 * consistent automatically — it counts whatever the table holds.
 *
 * The rolling-summary regeneration is intentionally NOT here: W11 owns
 * it. Callers signal it through scheduleSummaryRegeneration after a
 * successful delete (the delete → regen seam in plan T1).
 */
export async function deleteEntry(id: EntryId): Promise<void> {
  await db.transaction('rw', db.entries, db.followupResponses, async () => {
    const existing = await db.entries.get(id)
    if (!existing) {
      throw new Error(`Entry ${id} not found — nothing was deleted`)
    }
    await db.followupResponses.where('entryId').equals(id).delete()
    await db.entries.delete(id)
  })
}
