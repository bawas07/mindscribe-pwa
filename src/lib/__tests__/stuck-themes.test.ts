/**
 * W9 — themed stuck prompts: template phrasing (non-clinical, grounded,
 * deterministic, topic hygiene), pickPromptTheme integration (recent +
 * recurring selection), and the two-tier rotation fallback (themed
 * questions exhausted → generic pool seeded by entry count, T8).
 */
import { describe, expect, it } from 'vitest'
import { GENERIC_STUCK_PROMPTS } from '../stuck-prompts'
import {
  advanceStuckPromptFlow,
  buildThemedStuckPrompts,
  currentStuckPromptFlow,
  startStuckPromptFlow,
  type StuckPromptFlow,
  type ThemedPromptSet,
} from '../stuck-themes'
import {
  matchThemesToEntries,
  pickPromptTheme,
  type Theme,
  type ThemeEntryInput,
} from '../model/themes'

// Aug 17, 2026, local noon — the fixed "now" every match runs against.
const NOW = new Date(2026, 7, 17, 12, 0, 0)

function daysAgoIso(daysAgo: number): string {
  return new Date(2026, 7, 17 - daysAgo, 9, 30).toISOString()
}

function entry(content: string, daysAgo: number): ThemeEntryInput {
  return { createdAt: daysAgoIso(daysAgo), content }
}

function match(topics: string[], entries: ThemeEntryInput[]): Theme[] {
  return matchThemesToEntries(topics, entries, NOW)
}

/** Presses "Not this one" `n` times from a flow and returns the resulting flow. */
function advanceN(flow: StuckPromptFlow, n: number): StuckPromptFlow {
  let current = flow
  for (let step = 0; step < n; step++) current = advanceStuckPromptFlow(current)
  return current
}

/** Banned CBT/clinical residue — the guardrails' vocabulary must never leak. */
const BANNED_TOKENS = [
  'evidence',
  'reframe',
  'balance',
  'friend',
  'should',
  'homework',
  'exercise',
  'practice',
  'diagnos',
  'how did you feel about',
]

describe('buildThemedStuckPrompts — template phrasing', () => {
  const themes = match(['river walk', 'work'], [
    entry('went for a river walk this morning', 0),
    entry('river walk again at dusk', 3),
    entry('work was busy', 5),
  ])

  it('grounds an open question in the picked theme (recent + recurring per pickPromptTheme)', () => {
    const result = buildThemedStuckPrompts(themes)
    expect(result).not.toBeNull()
    expect(result?.theme.topic).toBe('river walk')
    expect(result?.prompts.length).toBeGreaterThanOrEqual(1)
    for (const prompt of result!.prompts) {
      expect(prompt.trim().endsWith('?')).toBe(true)
      expect(prompt).toContain('river walk')
      expect(prompt.length).toBeGreaterThan(20)
    }
  })

  it('never evaluates, diagnoses or advises — no banned CBT tokens, no "how did you feel about"', () => {
    const result = buildThemedStuckPrompts(themes)
    for (const prompt of result!.prompts) {
      const lower = prompt.toLowerCase()
      for (const banned of BANNED_TOKENS) {
        expect(lower).not.toContain(banned)
      }
    }
  })

  it('is deterministic: identical input and hash yield identical prompts in order', () => {
    expect(buildThemedStuckPrompts(themes, 2)).toEqual(buildThemedStuckPrompts(themes, 2))
  })

  it('returns null when no theme is selectable (empty list or zero-match themes)', () => {
    expect(buildThemedStuckPrompts([])).toBeNull()
    expect(
      buildThemedStuckPrompts([{ topic: 'ghost', lastMentionedDaysAgo: 0, mentionCount: 0 }]),
    ).toBeNull()
  })
})

describe('buildThemedStuckPrompts — topic hygiene', () => {
  it('lowercases, collapses whitespace and strips trailing punctuation for mid-sentence insertion', () => {
    const themes: Theme[] = [{ topic: '  River  Walk!!\n', lastMentionedDaysAgo: 0, mentionCount: 2 }]
    const result = buildThemedStuckPrompts(themes)
    expect(result?.prompts[0]).toBe(
      'You mentioned river walk recently — has anything shifted with it?',
    )
    for (const prompt of result!.prompts) {
      // No double spaces, no trailing period/punctuation leaked from the topic.
      expect(prompt).not.toMatch(/\s{2,}/)
      expect(prompt).not.toContain('!!')
      expect(prompt).not.toContain('River')
      expect(prompt).not.toContain('Walk')
    }
  })

  it('handles an all-caps topic and a topic with a trailing period', () => {
    const themes: Theme[] = [{ topic: 'DEPGRAPH LAUNCH.', lastMentionedDaysAgo: 0, mentionCount: 2 }]
    const result = buildThemedStuckPrompts(themes)
    expect(result?.prompts[0]).toBe(
      'You mentioned depgraph launch recently — has anything shifted with it?',
    )
  })

  it('themeHash rotates the starting template; every template still appears, none repeated', () => {
    const themes: Theme[] = [{ topic: 'river walk', lastMentionedDaysAgo: 0, mentionCount: 2 }]
    const fromZero = buildThemedStuckPrompts(themes, 0)!.prompts
    const fromOne = buildThemedStuckPrompts(themes, 1)!.prompts

    expect(fromZero[0]).toContain('You mentioned river walk')
    expect(fromOne[0]).toContain('on your mind')
    // Same pool, rotated — identical contents, different order.
    expect(new Set(fromZero)).toEqual(new Set(fromOne))
    expect(new Set(fromZero).size).toBe(fromZero.length)
    expect(new Set(fromOne).size).toBe(fromOne.length)
  })

  it('defensively returns null when the picked theme has no usable topic text', () => {
    const themes: Theme[] = [{ topic: '', lastMentionedDaysAgo: 0, mentionCount: 1 }]
    expect(buildThemedStuckPrompts(themes)).toBeNull()
  })
})

describe('pickPromptTheme integration — recent + recurring selection', () => {
  it('grounds the prompt in the recurring theme even when a recent one-off exists', () => {
    const themes = match(['recent once', 'recurring'], [
      entry('recent once today', 0),
      entry('recurring on monday', 4),
      entry('recurring again', 6),
    ])
    const result = buildThemedStuckPrompts(themes)
    expect(result?.theme.topic).toBe('recurring')
    // The selection matches themes.ts' own pickPromptTheme semantics exactly.
    expect(result?.theme.topic).toBe(pickPromptTheme(themes)?.topic)
  })

  it('falls back to the most recent single mention for thin history', () => {
    const themes = match(['one off'], [entry('one off today', 0)])
    const result = buildThemedStuckPrompts(themes)
    expect(result?.theme.topic).toBe('one off')
    expect(result?.theme.topic).toBe(pickPromptTheme(themes)?.topic)
  })
})

describe('stuck-prompt flow — tiered fallback (themed → generic)', () => {
  const themedSet: ThemedPromptSet = buildThemedStuckPrompts(
    [{ topic: 'river walk', lastMentionedDaysAgo: 0, mentionCount: 2 }],
    0,
  )!

  it('starts in tier 1 and walks the themed questions without repeating any', () => {
    let flow = startStuckPromptFlow(themedSet.prompts, 7)
    expect(flow.tier).toBe('themed')
    const seen = new Set<string>([currentStuckPromptFlow(flow)])
    for (let step = 1; step < themedSet.prompts.length; step++) {
      flow = advanceStuckPromptFlow(flow)
      expect(flow.tier).toBe('themed')
      const prompt = currentStuckPromptFlow(flow)
      expect(seen.has(prompt)).toBe(false)
      seen.add(prompt)
    }
    expect(seen.size).toBe(themedSet.prompts.length)
  })

  it('falls through to the generic pool after the themed questions run out, seeded by entry count (T8)', () => {
    // Entry count 3 seeds BOTH tiers: the themed template start (3 % 3 = 0,
    // canonical order) and the generic pool start (index 3).
    let flow = startStuckPromptFlow(themedSet.prompts, 3)
    flow = advanceN(flow, themedSet.prompts.length)

    expect(flow.tier).toBe('generic')
    expect(currentStuckPromptFlow(flow)).toBe(GENERIC_STUCK_PROMPTS[3])

    // Inside tier 2 the generic rotation continues — no dead end after the fall.
    flow = advanceStuckPromptFlow(flow)
    expect(flow.tier).toBe('generic')
    expect(currentStuckPromptFlow(flow)).toBe(GENERIC_STUCK_PROMPTS[4])
  })

  it('never repeats a themed question, even when "Not this one" keeps getting pressed', () => {
    let flow = startStuckPromptFlow(themedSet.prompts, 0)
    const seenThemed: string[] = []
    for (let step = 0; step < themedSet.prompts.length + 3; step++) {
      if (flow.tier === 'themed') seenThemed.push(currentStuckPromptFlow(flow))
      flow = advanceStuckPromptFlow(flow)
    }
    // Every themed question appeared exactly once; the extra presses lived in tier 2.
    expect(new Set(seenThemed).size).toBe(themedSet.prompts.length)
  })

  it('no meaningful summary: flow starts straight in tier 2 and stays generic', () => {
    expect(buildThemedStuckPrompts([])).toBeNull()
    let flow = startStuckPromptFlow([], 2)
    expect(flow.tier).toBe('generic')
    expect(currentStuckPromptFlow(flow)).toBe(GENERIC_STUCK_PROMPTS[2])

    flow = advanceStuckPromptFlow(flow)
    expect(flow.tier).toBe('generic')
    expect(currentStuckPromptFlow(flow)).toBe(GENERIC_STUCK_PROMPTS[3])
  })
})