import { describe, expect, it } from 'vitest'
import {
  advanceStuckPrompt,
  currentStuckPrompt,
  GENERIC_STUCK_PROMPTS,
  startStuckPromptCycle,
} from '../stuck-prompts'

describe('GENERIC_STUCK_PROMPTS (W6b pool)', () => {
  it('holds a warm pool of at least 6 unique, non-clinical prompts', () => {
    expect(GENERIC_STUCK_PROMPTS.length).toBeGreaterThanOrEqual(6)
    expect(new Set(GENERIC_STUCK_PROMPTS).size).toBe(GENERIC_STUCK_PROMPTS.length)
    for (const prompt of GENERIC_STUCK_PROMPTS) {
      expect(prompt.trim().endsWith('?')).toBe(true)
      expect(prompt.length).toBeGreaterThan(20)
    }
  })
})

describe('startStuckPromptCycle — deterministic, seeded', () => {
  it('is deterministic: the same seed opens the same first prompt', () => {
    expect(startStuckPromptCycle(3)).toEqual(startStuckPromptCycle(3))
    expect(currentStuckPrompt(startStuckPromptCycle(3))).toBe(
      currentStuckPrompt(startStuckPromptCycle(3)),
    )
  })

  it('seeds by entry count (T8): consecutive entry counts open on different prompts', () => {
    const firsts = GENERIC_STUCK_PROMPTS.map((_, seed) =>
      currentStuckPrompt(startStuckPromptCycle(seed)),
    )
    // Every seed index maps to a distinct first prompt before the pool wraps.
    expect(new Set(firsts).size).toBe(GENERIC_STUCK_PROMPTS.length)
  })

  it('wraps the seed safely (negative / beyond pool size)', () => {
    expect(currentStuckPrompt(startStuckPromptCycle(-2))).toBe(
      currentStuckPrompt(startStuckPromptCycle(GENERIC_STUCK_PROMPTS.length - 2)),
    )
  })
})

describe('advanceStuckPrompt — "Not this one" rotation', () => {
  it('never repeats a prompt before the whole pool has been shown (per-entry)', () => {
    let state = startStuckPromptCycle(0)
    const seen = new Set<string>([currentStuckPrompt(state)])

    for (let step = 1; step < GENERIC_STUCK_PROMPTS.length; step++) {
      state = advanceStuckPrompt(state)
      const prompt = currentStuckPrompt(state)
      expect(seen.has(prompt)).toBe(false)
      seen.add(prompt)
    }
    expect(seen.size).toBe(GENERIC_STUCK_PROMPTS.length)
  })

  it('wraps to a repeat only after the pool is exhausted', () => {
    let state = startStuckPromptCycle(0)
    const seen: string[] = [currentStuckPrompt(state)]
    for (let step = 1; step < GENERIC_STUCK_PROMPTS.length; step++) {
      state = advanceStuckPrompt(state)
      seen.push(currentStuckPrompt(state))
    }
    state = advanceStuckPrompt(state)
    expect(seen).toContain(currentStuckPrompt(state))
  })

  it('is deterministic: same state in, same state out', () => {
    const state = startStuckPromptCycle(4)
    expect(advanceStuckPrompt(state)).toEqual(advanceStuckPrompt(state))
  })
})