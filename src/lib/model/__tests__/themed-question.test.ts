/**
 * W9 — theme-grounded question generation (model-phrased tier 1).
 *
 * CI-clean: the real model is never loaded — `generateThemedQuestion` on
 * the shared client is mocked at the seam themed-question.ts calls (same
 * pattern as followups.test.ts / summary.test.ts). Covers the "?"-rule
 * validator, the exact-overlap mention-entry selection (W11 matcher), the
 * recency/recurrence-grounded context assembly, the single hotter retry,
 * and the loud failure contract the view swallows into the template.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { modelClient } from '../wllama-client'
import {
  assembleThemedContext,
  generateThemedQuestion,
  selectMentionEntries,
  THEMED_MAX_MENTION_ENTRIES,
  THEMED_MENTION_MAX_CHARS,
  THEMED_QUESTION_RETRY_TEMPERATURE,
  validateThemedQuestion,
  type ThemedMentionEntry,
} from '../themed-question'
import type { Theme } from '../themes'

// Aug 17, 2026, local noon — the fixed "now" every day-label is relative to.
const NOW = new Date(2026, 7, 17, 12, 0, 0)

function daysAgoIso(daysAgo: number): string {
  return new Date(2026, 7, 17 - daysAgo, 9, 30).toISOString()
}

const THEME: Theme = { topic: 'river walk', lastMentionedDaysAgo: 3, mentionCount: 2 }

const MENTION_ENTRIES: readonly ThemedMentionEntry[] = [
  { id: 'e1', content: 'went for a river walk this morning', createdAt: daysAgoIso(0) },
  { id: 'e2', content: 'river walk again at dusk', createdAt: daysAgoIso(5) },
]

let generateThemedSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  vi.restoreAllMocks()
})

describe('validateThemedQuestion — the hard "?" rule (spike C2)', () => {
  it('accepts only non-empty text ending in a question mark (after trimming)', () => {
    expect(validateThemedQuestion('Has anything shifted with the river walk?')).toBe(true)
    expect(validateThemedQuestion('  Has anything shifted?  ')).toBe(true)
    expect(validateThemedQuestion('What has it been like since?\n')).toBe(true)
  })

  it('rejects empty and non-question output', () => {
    expect(validateThemedQuestion('')).toBe(false)
    expect(validateThemedQuestion('   ')).toBe(false)
    expect(validateThemedQuestion('It sounded like the walk mattered')).toBe(false)
    expect(validateThemedQuestion('What has shifted since then')).toBe(false)
  })
})

describe('selectMentionEntries — grounded, bounded, exact-overlap (W11 matcher)', () => {
  const entries: readonly ThemedMentionEntry[] = [
    { id: 'm1', content: 'river walk at dawn', createdAt: daysAgoIso(0) },
    // Partial mention ("river" without "walk") must NOT ground the question.
    { id: 'm2', content: 'the river was high today', createdAt: daysAgoIso(1) },
    { id: 'm3', content: 'another river walk, dusk again', createdAt: daysAgoIso(2) },
  ]

  it('keeps only entries that actually mention the topic; partial mentions drop', () => {
    expect(selectMentionEntries(entries, 'river walk').map((entry) => entry.id)).toEqual(['m1', 'm3'])
  })

  it('bounds to at most THEMED_MAX_MENTION_ENTRIES (2), preserving input order', () => {
    const many = [...entries, { id: 'm4', content: 'river walk number four', createdAt: daysAgoIso(3) }]
    expect(THEMED_MAX_MENTION_ENTRIES).toBe(2)
    expect(selectMentionEntries(many, 'river walk')).toHaveLength(2)
  })

  it('returns [] when nothing mentions the topic', () => {
    expect(selectMentionEntries(entries, 'work deadlines')).toEqual([])
  })
})

describe('assembleThemedContext — recency + recurrence + grounded mentions', () => {
  it('includes the theme facts with natural recency/recurrence tokens', () => {
    const context = assembleThemedContext({ theme: THEME, mentionEntries: MENTION_ENTRIES }, NOW)
    expect(context).toContain('THEME: "river walk"')
    expect(context).toContain('mentioned in 2 entries, last 3 days ago.')
  })

  it('labels each mention entry with its whole-days-ago (deterministic with injected now)', () => {
    const context = assembleThemedContext({ theme: THEME, mentionEntries: MENTION_ENTRIES }, NOW)
    expect(context).toContain('RECENT (0 days ago): went for a river walk this morning')
    expect(context).toContain('RECENT (5 days ago): river walk again at dusk')
  })

  it('bounds each mention entry to THEMED_MENTION_MAX_CHARS with an ellipsis', () => {
    const long = 'x'.repeat(THEMED_MENTION_MAX_CHARS + 200)
    const context = assembleThemedContext(
      { theme: THEME, mentionEntries: [{ id: 'p1', content: long, createdAt: daysAgoIso(0) }] },
      NOW,
    )
    expect(context).toContain(`${'x'.repeat(THEMED_MENTION_MAX_CHARS)}…`)
    expect(context).not.toContain('x'.repeat(THEMED_MENTION_MAX_CHARS + 100))
  })

  it('still grounds the theme facts alone when no mention entries were found', () => {
    const context = assembleThemedContext({ theme: THEME, mentionEntries: [] }, NOW)
    expect(context).toContain('THEME: "river walk"')
    expect(context).toContain('mentioned in 2 entries, last 3 days ago.')
    expect(context).not.toContain('ENTRIES THAT MENTION')
  })

  it('uses "today" and "one recent mention" for a fresh single mention', () => {
    const context = assembleThemedContext(
      { theme: { topic: 'work', lastMentionedDaysAgo: 0, mentionCount: 1 }, mentionEntries: [] },
      NOW,
    )
    expect(context).toContain('one recent mention, last today.')
  })
})

describe('generateThemedQuestion — one validated, theme-grounded question', () => {
  it('returns the trimmed question + mention-entry ids from a valid reply, no retry', async () => {
    generateThemedSpy = vi
      .spyOn(modelClient, 'generateThemedQuestion')
      .mockResolvedValue('  Did the evening river walk shift anything for you?  ')

    const result = await generateThemedQuestion({ theme: THEME, mentionEntries: MENTION_ENTRIES })

    expect(result).toEqual({
      text: 'Did the evening river walk shift anything for you?',
      referencedEntryIds: ['e1', 'e2'],
    })
    expect(generateThemedSpy).toHaveBeenCalledTimes(1)
  })

  it('grounds the context in the theme facts and only the passed mention entries', async () => {
    generateThemedSpy = vi
      .spyOn(modelClient, 'generateThemedQuestion')
      .mockResolvedValue('How has it been since the last river walk?')

    await generateThemedQuestion({ theme: THEME, mentionEntries: MENTION_ENTRIES })

    const context = generateThemedSpy.mock.calls[0][0]
    expect(context).toContain('THEME: "river walk"')
    expect(context).toContain('mentioned in 2 entries, last 3 days ago.')
    expect(context).toContain('went for a river walk this morning')
    expect(context).toContain('river walk again at dusk')
  })

  it('retries exactly once at the hotter temperature when the first output lacks a "?"', async () => {
    generateThemedSpy = vi.spyOn(modelClient, 'generateThemedQuestion')
    generateThemedSpy
      .mockResolvedValueOnce('I wonder whether the walk helped')
      .mockResolvedValueOnce('Has anything shifted with the river walk since?')

    const result = await generateThemedQuestion({ theme: THEME, mentionEntries: [] })

    // Exactly ONE retry (spike G2), and it runs at the hotter spike C2
    // temperature — the first call uses the shell default (no override).
    expect(generateThemedSpy).toHaveBeenCalledTimes(2)
    expect(generateThemedSpy.mock.calls[1][1]).toEqual({
      temperature: THEMED_QUESTION_RETRY_TEMPERATURE,
    })
    expect(result.text).toBe('Has anything shifted with the river walk since?')
  })

  it('fails loudly after two non-question outputs — the caller falls back to the template', async () => {
    generateThemedSpy = vi.spyOn(modelClient, 'generateThemedQuestion')
    generateThemedSpy
      .mockResolvedValueOnce('no question mark here')
      .mockResolvedValueOnce('still no question mark')

    await expect(generateThemedQuestion({ theme: THEME, mentionEntries: [] })).rejects.toThrow(
      'Themed question generation failed: the model did not produce a question',
    )

    // Exactly two attempts: one generation + one retry, never a loop.
    expect(generateThemedSpy).toHaveBeenCalledTimes(2)
  })
})