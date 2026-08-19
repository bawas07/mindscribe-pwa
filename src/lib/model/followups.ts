/**
 * W10 — follow-up question generation (spike §4 Task A, condition C2).
 *
 * Builds the grounded context (current entry + up to two recent previous
 * entries, so referencedEntryIds are real), runs the wllama Task A shell
 * (temp 0.5, no-think, 60 max tokens) and validates the output: a non-empty
 * string ending in "?". A rejected output triggers exactly ONE retry at
 * temperature 0.7 (spike G2 — without it, format compliance is only
 * ~60–70%), then fails loudly so the caller can drop the follow-up without
 * ever blocking a save.
 *
 * KV-cache reuse (spike §7): every call goes through the shared `modelClient`
 * singleton, so Q1 and Q2 run on the SAME loaded Wllama instance. Whether
 * wllama carries KV state across two createChatCompletion calls is a
 * real-device measurement (W12); the seam that enables it is reusing the one
 * instance — the second follow-up is ~3× faster when the cache is reused.
 */
import { modelClient, SYSTEM_FOLLOWUP_PROMPT } from './wllama-client'

/** One question the model grounded in the current entry (and up to 2 earlier ones). */
export interface FollowupQuestion {
  text: string
  /** Ids of previous entries the question may reference — drive the swipe-peek. */
  referencedEntryIds: string[]
}

/** A previous entry the question may be grounded in. */
export interface FollowupContextEntry {
  id: string
  content: string
  createdAt: string
  /** Relative label for human context, e.g. "Monday's entry". */
  label?: string
}

/** The Task A system prompt — the non-CBT guardrails live in wllama-client. */
export const followupSystemPrompt: string = SYSTEM_FOLLOWUP_PROMPT

/** Retry sampling (spike C2 / G2): a single hotter retry for format compliance. */
export const FOLLOWUP_RETRY_TEMPERATURE = 0.7
export const FOLLOWUP_MAX_RETRIES = 1

/** Bound each referenced entry so the ~2048-token context never blows. */
export const FOLLOWUP_REFERENCE_MAX_CHARS = 500
/** At most two previous entries are ever grounded into a question. */
export const FOLLOWUP_MAX_REFERENCED_ENTRIES = 2

/**
 * Hard rejection rule: a follow-up must be a non-empty string ending in "?".
 * This is the validator shipped per spike C2 (ends-with-"?" is the gate;
 * the system prompt's "about 20 words, ONE question" shapes the rest).
 */
export function validateFollowupQuestion(text: string): boolean {
  const trimmed = text.trim()
  if (trimmed.length === 0) return false
  return trimmed.endsWith('?')
}

function truncateForContext(text: string): string {
  return text.length <= FOLLOWUP_REFERENCE_MAX_CHARS
    ? text
    : `${text.slice(0, FOLLOWUP_REFERENCE_MAX_CHARS).trimEnd()}…`
}

/**
 * Assembles the model context per the architecture doc: the CURRENT entry,
 * then up to two recent previous entries (labeled), so references are real
 * and grounded rather than hallucinated.
 */
export function assembleFollowupContext(input: {
  entryContent: string
  previousEntries: readonly FollowupContextEntry[]
}): string {
  const parts = [`CURRENT ENTRY:\n${input.entryContent}`]

  const references = input.previousEntries.slice(0, FOLLOWUP_MAX_REFERENCED_ENTRIES)
  if (references.length > 0) {
    const labeled = references
      .map((entry) => `RECENT (${entry.label ?? 'earlier'}):\n${truncateForContext(entry.content)}`)
      .join('\n\n')
    parts.push(`EARLIER ENTRIES YOU MAY REFERENCE (only if relevant):\n${labeled}`)
  }

  return parts.join('\n\n')
}

/**
 * Generates one validated, grounded question. On a non-"?" output, retries
 * exactly once at temperature 0.7; if both attempts fail to form a question,
 * throws — the caller surfaces a graceful "no follow-up this time" rather
 * than ever blocking a save.
 */
export async function generateFollowUpQuestion(input: {
  entryContent: string
  previousEntries: readonly FollowupContextEntry[]
}): Promise<FollowupQuestion> {
  const context = assembleFollowupContext(input)
  const referencedEntryIds = input.previousEntries
    .slice(0, FOLLOWUP_MAX_REFERENCED_ENTRIES)
    .map((entry) => entry.id)

  let text = await modelClient.generateFollowUp(context)
  if (!validateFollowupQuestion(text)) {
    text = await modelClient.generateFollowUp(context, { temperature: FOLLOWUP_RETRY_TEMPERATURE })
  }
  if (!validateFollowupQuestion(text)) {
    throw new Error('Follow-up generation failed: the model did not produce a question')
  }

  return { text: text.trim(), referencedEntryIds }
}
