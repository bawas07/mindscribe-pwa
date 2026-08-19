/**
 * W9 — theme-grounded stuck-prompt question generation (tier 1, model-phrased).
 *
 * PRODUCT DECISION (supersedes template-phrased tier 1): given the theme
 * picked by `pickPromptTheme` (topic + lastMentionedDaysAgo + mentionCount)
 * and up to two recent entries that actually mention it, the on-device
 * model phrases ONE fresh, gentle, non-presumptuous open question. The
 * template pool in stuck-themes.ts stays as the FALLBACK when the model is
 * unavailable (not downloaded / gate declined / load or generation fails)
 * — a stuck prompt never dead-ends.
 *
 * Runs the same spike-validated shell as the follow-up (Task A, condition
 * C2): temperature 0.5, no-think, ~50 max tokens, validator requires a
 * trailing "?", exactly ONE retry at 0.7, then a loud failure the view
 * swallows into the template fallback. CI-clean: the real model is never
 * loaded — tests mock the client seam (`modelClient.generateThemedQuestion`).
 */
import { modelClient, SYSTEM_THEMED_QUESTION_PROMPT } from './wllama-client'
import { entryMentionsTopic, wholeDaysAgo, type Theme } from './themes'

/** One model-phrased question + the entries it was grounded in (peek seam, unused today). */
export interface ThemedQuestion {
  text: string
  /** Ids of the mention entries the context was grounded in (D6-style, future peek). */
  referencedEntryIds: string[]
}

/** A recent entry the theme may mention — the subset the model context needs. */
export interface ThemedMentionEntry {
  id: string
  content: string
  createdAt: string
}

/** Retry sampling (spike C2 / G2): a single hotter retry for format compliance. */
export const THEMED_QUESTION_RETRY_TEMPERATURE = 0.7
export const THEMED_QUESTION_MAX_RETRIES = 1
/** Bound each mention entry so the ~2048-token context never blows. */
export const THEMED_MENTION_MAX_CHARS = 500
/** At most two mention entries ever ground a themed question. */
export const THEMED_MAX_MENTION_ENTRIES = 2

/**
 * Hard rejection rule: a themed question must be a non-empty string ending
 * in "?" — the same ends-with-"?" gate the follow-up ships (spike C2).
 */
export function validateThemedQuestion(text: string): boolean {
  const trimmed = text.trim()
  if (trimmed.length === 0) return false
  return trimmed.endsWith('?')
}

function truncateForContext(text: string): string {
  return text.length <= THEMED_MENTION_MAX_CHARS
    ? text
    : `${text.slice(0, THEMED_MENTION_MAX_CHARS).trimEnd()}…`
}

/**
 * Picks up to `max` recent entries that actually mention the topic, reusing
 * the W11 exact word-overlap matcher — so a partial mention ("river" alone
 * for "river walk") never leaks into the model's grounding. Order follows
 * the input (recent first); bound `max` by THEMED_MAX_MENTION_ENTRIES (2).
 */
export function selectMentionEntries(
  entries: readonly ThemedMentionEntry[],
  topic: string,
  max: number = THEMED_MAX_MENTION_ENTRIES,
): ThemedMentionEntry[] {
  return entries.filter((entry) => entryMentionsTopic(entry.content, topic)).slice(0, max)
}

/**
 * Assembles the model context: the theme's structured facts (recency +
 * recurrence, so the model can weave them in naturally) and the mention
 * entries labeled with whole-days-ago. `now` is injectable so tests are
 * deterministic. With no mention entries found, the theme facts alone
 * still ground the question — the caller never blocks on the entries.
 */
export function assembleThemedContext(
  input: { theme: Theme; mentionEntries: readonly ThemedMentionEntry[] },
  now: Date = new Date(),
): string {
  const { theme, mentionEntries } = input
  const daysLabel = theme.lastMentionedDaysAgo === 0 ? 'today' : `${theme.lastMentionedDaysAgo} days ago`
  const recurrenceLabel =
    theme.mentionCount >= 2 ? `mentioned in ${theme.mentionCount} entries` : 'one recent mention'
  const lines = [`THEME: "${theme.topic}"`, `How it shows up: ${recurrenceLabel}, last ${daysLabel}.`]

  if (mentionEntries.length > 0) {
    const mentions = mentionEntries
      .map(
        (entry) =>
          `RECENT (${wholeDaysAgo(entry.createdAt, now)} days ago): ${truncateForContext(entry.content)}`,
      )
      .join('\n')
    lines.push(`ENTRIES THAT MENTION "${theme.topic}":\n${mentions}`)
  }

  return lines.join('\n\n')
}

/**
 * Generates one validated, theme-grounded question. On a non-"?" output,
 * retries exactly once at temperature 0.7; if both attempts fail to form a
 * question, throws — the caller (NewEntryView tier 1) falls back to the
 * template pool rather than ever showing an error or a dead end.
 */
export async function generateThemedQuestion(input: {
  theme: Theme
  mentionEntries: readonly ThemedMentionEntry[]
}): Promise<ThemedQuestion> {
  const context = assembleThemedContext(input)
  const referencedEntryIds = input.mentionEntries.map((entry) => entry.id)

  let text = await modelClient.generateThemedQuestion(context)
  if (!validateThemedQuestion(text)) {
    text = await modelClient.generateThemedQuestion(context, {
      temperature: THEMED_QUESTION_RETRY_TEMPERATURE,
    })
  }
  if (!validateThemedQuestion(text)) {
    throw new Error('Themed question generation failed: the model did not produce a question')
  }

  return { text: text.trim(), referencedEntryIds }
}

/** The system prompt the shell uses — exported for tests/config audits. */
export const themedQuestionSystemPrompt: string = SYSTEM_THEMED_QUESTION_PROMPT