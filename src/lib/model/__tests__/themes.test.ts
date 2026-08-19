/**
 * W11 — app-side theme matcher (spike condition C1).
 *
 * These are the accuracy-critical tests: the model only names themes, and
 * every number the app shows (mentionCount, lastMentionedDaysAgo) comes from
 * `matchThemesToEntries`. All dates are relative to a fixed `now` so the
 * results are fully deterministic.
 */
import { describe, expect, it } from 'vitest'
import {
  matchThemesToEntries,
  pickPromptTheme,
  tokenize,
  wholeDaysAgo,
  type Theme,
  type ThemeEntryInput,
} from '../themes'

// Aug 17, 2026, local noon — the fixed "now" every test runs against.
const NOW = new Date(2026, 7, 17, 12, 0, 0)

/** An entry timestamp `daysAgo` whole days before NOW (same time of day). */
function daysAgoIso(daysAgo: number): string {
  return new Date(2026, 7, 17 - daysAgo, 9, 30).toISOString()
}

function entry(content: string, daysAgo: number): ThemeEntryInput {
  return { createdAt: daysAgoIso(daysAgo), content }
}

function match(topics: string[], entries: ThemeEntryInput[]): Theme[] {
  return matchThemesToEntries(topics, entries, NOW)
}

describe('tokenize — documented edge cases', () => {
  it('lowercases and splits on non-alphanumeric characters', () => {
    expect(tokenize('River Walk!')).toEqual(['river', 'walk'])
    expect(tokenize('Going for a river-walk today.')).toEqual(['going', 'for', 'a', 'river', 'walk', 'today'])
    expect(tokenize("I'm at work")).toEqual(['i', 'm', 'at', 'work']) // apostrophe splits
  })

  it('does NOT stem — walk and walked are different tokens', () => {
    expect(tokenize('walked by the river')).not.toContain('walk')
    expect(tokenize('walk')).toEqual(['walk'])
  })

  it('returns [] for empty / symbol-only text', () => {
    expect(tokenize('')).toEqual([])
    expect(tokenize('   ...!!!  ')).toEqual([])
  })
})

describe('wholeDaysAgo', () => {
  it('today is 0, yesterday is 1, seven days ago is 7', () => {
    expect(wholeDaysAgo(daysAgoIso(0), NOW)).toBe(0)
    expect(wholeDaysAgo(daysAgoIso(1), NOW)).toBe(1)
    expect(wholeDaysAgo(daysAgoIso(7), NOW)).toBe(7)
  })

  it('clamps future / clock-skewed timestamps to 0', () => {
    expect(wholeDaysAgo(daysAgoIso(-1), NOW)).toBe(0)
  })
})

describe('matchThemesToEntries — exact overlap counting (C1)', () => {
  it('counts how many entries mention a single-word theme', () => {
    const themes = match(['sleep'], [
      entry('slept badly again tonight', 0),
      entry('the sleep last night was great', 2),
      entry('nothing about rest here', 4),
    ])
    expect(themes[0]).toMatchObject({ topic: 'sleep', mentionCount: 1, lastMentionedDaysAgo: 2 })
  })

  it('ignores entries that only mention some words of a multi-word theme (partial)', () => {
    const themes = match(['river walk'], [
      entry('a calm day by the river', 0),
      entry('went for a long walk', 1),
      entry('river walk in the morning', 3),
    ])
    // Only the entry containing BOTH "river" and "walk" counts.
    expect(themes[0]).toEqual({ topic: 'river walk', mentionCount: 1, lastMentionedDaysAgo: 3 })
  })

  it('matches near-miss phrases where both words appear close together', () => {
    const near = entry('walk to the river this evening', 2)
    // "walk" and "river" sit within the 4-token window (slack = 2) -> match.
    expect(match(['river walk'], [near])[0].mentionCount).toBe(1)
    expect(match(['river walk'], [near])[0].lastMentionedDaysAgo).toBe(2)
  })

  it('misses words too far apart (outside the proximity window)', () => {
    const far = entry('the river far beyond the old bridge today and then a long walk after dinner', 0)
    expect(match(['river walk'], [far])[0].mentionCount).toBe(0)
  })

  it('matches a contiguous multi-word phrase', () => {
    expect(match(['river walk'], [entry('we went on a lovely river walk', 0)])[0].mentionCount).toBe(1)
  })

  it('is case-insensitive and punctuation-insensitive', () => {
    const themes = match(['River Walk'], [entry('RIVER WALK!', 0)])
    expect(themes[0].mentionCount).toBe(1)
  })

  it('handles hyphenated entries ("river-walk" == "river walk")', () => {
    expect(match(['river walk'], [entry('an evening river-walk', 0)])[0].mentionCount).toBe(1)
  })

  it('does not treat one word as a prefix of a longer token (exact overlap)', () => {
    // No stemming: "run" must not match "running", and "walk" must not
    // match "walked" (the near-miss above relies on the literal token).
    expect(match(['run'], [entry('went on my usual morning running', 0)])[0].mentionCount).toBe(0)
    expect(match(['river walk'], [entry('walked by the river', 0)])[0].mentionCount).toBe(0)
  })

  it('returns honest zero counts for topics no entry mentions', () => {
    const themes = match(['harbor visits'], [entry('nothing here', 0)])
    expect(themes[0]).toEqual({ topic: 'harbor visits', mentionCount: 0, lastMentionedDaysAgo: 0 })
  })

  it('returns [] for no topics, and zero-count themes for no entries', () => {
    expect(match([], [entry('anything', 0)])).toEqual([])
    const empty = match(['work'], [])
    expect(empty).toHaveLength(1)
    expect(empty[0].mentionCount).toBe(0)
    // Empty / symbol-only content never matches.
    expect(match(['work'], [{ createdAt: daysAgoIso(0), content: '  !!! ' }])[0].mentionCount).toBe(0)
  })
})

describe('matchThemesToEntries — lastMentionedDaysAgo correctness', () => {
  it('0 means a matching entry was written today', () => {
    const themes = match(['work'], [
      entry('busy day at work', 0),
      entry('work again', 5),
    ])
    expect(themes[0].lastMentionedDaysAgo).toBe(0)
  })

  it('reflects the MOST recent matching entry across dates', () => {
    // "sleep" mentioned 0, 2 and 5 days ago -> most recent is 0 days ago.
    // ("deep sleep" at day 0 contains the token "sleep"; "slept" would NOT.)
    expect(match(['sleep'], [
      entry('deep sleep', 0),
      entry('bad sleep', 2),
      entry('sleep', 5),
    ])[0].lastMentionedDaysAgo).toBe(0)
    // Only mentioned 2 and 5 days ago -> 2.
    expect(match(['sleep'], [
      entry('bad sleep', 2),
      entry('sleep', 5),
    ])[0].lastMentionedDaysAgo).toBe(2)
    // Only mentioned 5 days ago -> 5.
    expect(match(['sleep'], [entry('sleep', 5)])[0].lastMentionedDaysAgo).toBe(5)
  })
})

describe('matchThemesToEntries — deterministic ordering (W9)', () => {
  it('sorts most-recent first, then most-recurring, then alphabetically', () => {
    const topics = ['old recurring', 'recent once', 'old once', 'recent recurring']
    const themes = match(topics, [
      entry('recent recurring and also old recurring today', 0),
      entry('recent once today', 0),
      entry('old recurring and old once five days back', 5),
    ])
    expect(themes.map((t) => t.topic)).toEqual(['old recurring', 'recent once', 'recent recurring', 'old once'])
  })

  it('is stable for an identical input set', () => {
    const entries = [entry('river walk', 0), entry('work', 2)]
    expect(match(['work', 'river walk'], entries)).toEqual(match(['work', 'river walk'], entries))
  })
})

describe('pickPromptTheme — W9 seam', () => {
  it('returns undefined for an empty / no-match theme list', () => {
    expect(pickPromptTheme([])).toBeUndefined()
    expect(pickPromptTheme([{ topic: 'ghost', mentionCount: 0, lastMentionedDaysAgo: 0 }])).toBeUndefined()
  })

  it('prefers a recurring theme (>=2 mentions) over a recent one-off', () => {
    const themes = match(['recent once', 'recurring'], [
      entry('recent once today', 0),
      entry('recurring on monday', 4),
      entry('recurring again', 6),
    ])
    expect(pickPromptTheme(themes)?.topic).toBe('recurring')
  })

  it('falls back to the most recent single mention', () => {
    const themes = match(['one off'], [entry('one off today', 0)])
    expect(pickPromptTheme(themes)?.topic).toBe('one off')
  })
})
