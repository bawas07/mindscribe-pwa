/**
 * Theme matching — W11, spike condition C1.
 *
 * The 1B model returns theme phrases only (`{"themes":["..."]}`) because it
 * cannot count reliably. `mentionCount` and `lastMentionedDaysAgo` are
 * therefore computed deterministically here, app-side, by matching each
 * theme phrase against the entry texts it was prompted with
 * (docs/spike-model.md §5 and §9).
 *
 * Matching is EXACT word-overlap on tokenized text — deliberately simple and
 * predictable: no stemming, no synonyms, no embeddings (spike §9 open
 * question resolved in favour of exact word-overlap for M1).
 *   - A single-word theme ("sleep") matches an entry containing that exact
 *     token anywhere.
 *   - A multi-word theme ("river walk") matches an entry whose tokens contain
 *     ALL of the theme's words within a short sliding window (theme length +
 *     2 tokens). Natural phrases like "walk to the river" hit, while
 *     "river … five sentences later … walk" misses.
 *   - Partial / near-miss mentions (only some of a theme's words) never
 *     match — that's what keeps counts honest.
 *
 * Tokenization: lowercased, split on any non-alphanumeric character. So
 * "River Walk" == "river walk", "river-walk" -> ["river", "walk"], and
 * "I'm" -> ["i", "m"]. No stemming: "walk" and "walked" are different
 * tokens.
 *
 * `lastMentionedDaysAgo` = whole local calendar days since the most recent
 * matching entry's createdAt (0 = today). A theme that matches no entry gets
 * 0 (a "no match" sentinel) — the summary pipeline filters zero-count themes
 * out before persisting and `pickPromptTheme` skips them, so the sentinel
 * never reaches the UI.
 */

/** One recurring theme as the app measures it. camelCase in code (docs/data-schema.md). */
export interface Theme {
  topic: string
  /** Whole calendar days since the most recent matching entry (0 = today). */
  lastMentionedDaysAgo: number
  /** Number of input entries that mention this theme (0 = matched nothing). */
  mentionCount: number
}

/** Entry shape the matcher needs — a subset of what the entries repo returns. */
export interface ThemeEntryInput {
  createdAt: string
  content: string
}

const MS_PER_DAY = 86_400_000
/** Multi-word themes may contain up to this many filler tokens between words. */
const TOPIC_PROXIMITY_SLACK = 2

/**
 * Lowercases text and splits it on any non-alphanumeric character.
 * Edge cases (documented in the module header): punctuation and hyphens
 * split tokens, possessives/apostrophes split, and there is no stemming.
 */
export function tokenize(text: string): string[] {
  return text.toLowerCase().match(/[a-z0-9]+/g) ?? []
}

/**
 * Whole calendar days from a timestamp to `now` (floor, clamped to >= 0).
 * Uses local midnight-to-midnight days — the same calendar-day semantics the
 * rest of the app uses for dates. A future / clock-skewed timestamp reads as
 * 0 (today).
 */
export function wholeDaysAgo(timestamp: string, now: Date): number {
  const created = new Date(timestamp)
  const createdDay = new Date(created.getFullYear(), created.getMonth(), created.getDate()).getTime()
  const nowDay = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  return Math.max(0, Math.floor((nowDay - createdDay) / MS_PER_DAY))
}

/**
 * Deterministic app-side matcher (spike condition C1).
 *
 * For each theme topic: counts how many of the input entries mention it
 * (`mentionCount`) and how recently the most recent matching entry was
 * written (`lastMentionedDaysAgo`). `now` defaults to the current time and is
 * injectable so tests are deterministic.
 *
 * Results are sorted (for W9) by most-recent first, then most-recurring,
 * then alphabetically — deterministic for a given input set.
 */
export function matchThemesToEntries(
  themeTopics: readonly string[],
  entries: readonly ThemeEntryInput[],
  now: Date = new Date(),
): Theme[] {
  const entryDaysAgo = entries.map((entry) => wholeDaysAgo(entry.createdAt, now))

  const themes = themeTopics.map((topic) => {
    let mentionCount = 0
    let lastMentionedDaysAgo = 0
    for (let index = 0; index < entries.length; index++) {
      if (entryMentionsTopic(entries[index].content, topic)) {
        mentionCount += 1
        const daysAgo = entryDaysAgo[index]
        if (mentionCount === 1 || daysAgo < lastMentionedDaysAgo) {
          lastMentionedDaysAgo = daysAgo
        }
      }
    }
    return { topic, lastMentionedDaysAgo, mentionCount }
  })

  return themes.sort(compareThemes)
}

/**
 * W9 seam — deterministically pick the theme to base a stuck prompt on.
 * Prefers a theme mentioned in more than one entry (true recurrence),
 * falling back to the most recent single mention. Returns undefined when no
 * theme has any match (e.g. getThemes() == []). W9 turns the picked topic
 * into actual prompt phrasing.
 */
export function pickPromptTheme(themes: readonly Theme[]): Theme | undefined {
  if (themes.length === 0) return undefined
  return themes.find((theme) => theme.mentionCount >= 2) ?? themes.find((theme) => theme.mentionCount >= 1)
}

/**
 * Exact word-overlap test: does `content` mention every word of `topic`
 * close together? Single-word topics just need the token present; multi-word
 * topics need all tokens inside one sliding proximity window. Exported for
 * W9 (selecting the mention entries that ground a themed question).
 */
export function entryMentionsTopic(content: string, topic: string): boolean {
  const topicTokens = tokenize(topic)
  if (topicTokens.length === 0) return false
  const entryTokens = tokenize(content)
  if (entryTokens.length === 0) return false

  if (topicTokens.length === 1) {
    return entryTokens.includes(topicTokens[0])
  }

  const windowSize = Math.min(topicTokens.length + TOPIC_PROXIMITY_SLACK, entryTokens.length)
  for (let start = 0; start + windowSize <= entryTokens.length; start++) {
    if (windowContainsAllTokens(entryTokens.slice(start, start + windowSize), topicTokens)) {
      return true
    }
  }
  return false
}

/** True when a token window contains every topic token (count-aware). */
function windowContainsAllTokens(
  windowTokens: readonly string[],
  topicTokens: readonly string[],
): boolean {
  const needed = new Map<string, number>()
  for (const token of topicTokens) {
    needed.set(token, (needed.get(token) ?? 0) + 1)
  }
  for (const token of windowTokens) {
    const remaining = needed.get(token)
    if (remaining === undefined) continue
    if (remaining === 1) needed.delete(token)
    else needed.set(token, remaining - 1)
  }
  return needed.size === 0
}

/** Sorts themes deterministically: most recent, then most recurring, then alpha. */
function compareThemes(a: Theme, b: Theme): number {
  if (a.lastMentionedDaysAgo !== b.lastMentionedDaysAgo) {
    return a.lastMentionedDaysAgo - b.lastMentionedDaysAgo
  }
  if (a.mentionCount !== b.mentionCount) {
    return b.mentionCount - a.mentionCount
  }
  return a.topic.localeCompare(b.topic)
}
