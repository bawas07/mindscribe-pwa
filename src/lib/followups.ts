/**
 * W10 — follow-up persistence + the opt-in trigger rule.
 *
 * Write side follows the entries.ts discipline: plaintext in, encrypted out,
 * and the ONLY module that writes the followupResponses table (the W6b
 * constraint: views never touch encrypted columns directly). Each question
 * is persisted as its own FollowupResponse row (decision T2); the response
 * is the free-written delta captured from the shared writing surface, or
 * null when the question was skipped — stored as an empty encrypted string
 * so the read side (listFollowupsForEntry) maps it back to null cleanly.
 */
import { db } from './db/schema'
import { encryptText, getOrCreateDeviceKey } from './db/crypto'

/** Hard cap on questions per entry (decision T2: "max 2"). */
export const FOLLOWUP_MAX_QUESTIONS = 2
/**
 * The opt-in ("Want to talk about this?") is offered on ANY non-empty entry.
 * Earlier this was a length heuristic to avoid "noise", but the opt-in is
 * user-initiated (D5) — the model only generates after the user taps "Yes" —
 * so a threshold only ever made the feature feel broken on short entries
 * (real journal entries are often one line). Only emptiness is excluded.
 */
export const FOLLOWUP_WORTHY_MIN_LENGTH = 1

/** Strict cap (T2): a session may never ask more than two follow-ups. */
export function canAskFollowup(askedCount: number): boolean {
  return askedCount < FOLLOWUP_MAX_QUESTIONS
}

/**
 * Whether the opt-in ("Want to talk about this?") is even offered. Returns
 * false for empty/whitespace-only content only — any real entry qualifies;
 * the model never interjects on its own (D5), the opt-in is the user's call.
 */
export function isFollowupWorthy(content: string): boolean {
  const trimmed = content.trim()
  if (trimmed.length === 0) return false
  return trimmed.length >= FOLLOWUP_WORTHY_MIN_LENGTH
}

export interface FollowupResponseInput {
  entryId: string
  /** The model's (validated) follow-up question, in full. */
  question: string
  /** The free-written response delta; null when the question was skipped. */
  response: string | null
  /** Ids of entries the question was grounded in (plaintext — swipe-peek). */
  referencedEntryIds: string[]
}

/**
 * Persists one follow-up Q&A (question always, response optional/nulled on
 * skip) encrypted at rest, and flips the owning entry's hasFollowup flag —
 * both in the SAME readwrite transaction. Key material + encrypt run BEFORE
 * the transaction (Web Crypto promises must not be awaited inside a Dexie
 * transaction — same rule as crypto.ts / entries.ts).
 */
export async function createFollowupResponse(input: FollowupResponseInput): Promise<void> {
  if (!input.entryId) throw new Error('Cannot persist a follow-up without an entryId')
  const question = input.question.trim()
  if (question.length === 0) throw new Error('Cannot persist a follow-up without a question')

  const key = await getOrCreateDeviceKey()
  const questionEncrypted = await encryptText(key, question)
  // Skip stores an empty encrypted string: listFollowupsForEntry trims and
  // maps '' back to a null response for display.
  const responseEncrypted = await encryptText(key, input.response?.trim() ?? '')

  await db.transaction('rw', db.entries, db.followupResponses, async () => {
    const entry = await db.entries.get(input.entryId)
    if (!entry) {
      throw new Error(`Cannot attach a follow-up to missing entry ${input.entryId}`)
    }
    await db.followupResponses.add({
      id: crypto.randomUUID(),
      entryId: input.entryId,
      questionEncrypted,
      responseEncrypted,
      // Plain copy: views hand us reactive-proxy arrays (stored in refs),
      // and IndexedDB's structured clone rejects proxies with a
      // DataCloneError — the clone happens inside Dexie, not here.
      referencedEntryIds: [...input.referencedEntryIds],
      // Plaintext convenience timestamp for inline ordering (Q1 before Q2).
      // Not indexed — the read side sorts in JS, so no schema migration is
      // needed; Dexie persists undeclared properties as-is.
      createdAt: new Date().toISOString(),
    })
    // put() the FULL record, never update(): Dexie's update() is a
    // modify() that deep-clones the row before re-storing it, and its
    // deepClone has no ArrayBuffer branch — encryptText blobs come back as
    // empty shells, silently corrupting the entry (undecryptable forever).
    await db.entries.put({ ...entry, hasFollowup: true })
  })
}
