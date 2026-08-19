/**
 * W10 — follow-up question generation (spike §4 Task A, condition C2).
 *
 * CI-clean: the real model is never loaded — `generateFollowUp` on the
 * shared client is mocked at the seam followups.ts calls (same pattern as
 * summary.test.ts). Covers the validator, the grounded/bounded context
 * assembly, the single hotter retry, the graceful failure contract, and
 * that referencedEntryIds come from the passed previous entries.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { modelClient } from '../wllama-client'
import {
  assembleFollowupContext,
  FOLLOWUP_MAX_REFERENCED_ENTRIES,
  FOLLOWUP_REFERENCE_MAX_CHARS,
  FOLLOWUP_RETRY_TEMPERATURE,
  generateFollowUpQuestion,
  validateFollowupQuestion,
  type FollowupContextEntry,
} from '../followups'

const PREVIOUS_ENTRIES: readonly FollowupContextEntry[] = [
  { id: 'prev-1', content: 'The river walk at dawn, quiet and cold.', createdAt: '2026-08-16T09:30:00.000Z', label: "Sunday's entry" },
  { id: 'prev-2', content: 'Work was a blur of meetings again.', createdAt: '2026-08-15T09:30:00.000Z', label: "Saturday's entry" },
  { id: 'prev-3', content: 'This third entry must never reach the model.', createdAt: '2026-08-14T09:30:00.000Z', label: "Friday's entry" },
]

let generateFollowUpSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  vi.restoreAllMocks()
})

describe('validateFollowupQuestion — the hard "?" rule (spike C2)', () => {
  it('accepts only non-empty text ending in a question mark (after trimming)', () => {
    expect(validateFollowupQuestion('What made today better?')).toBe(true)
    expect(validateFollowupQuestion('  What made today better?  ')).toBe(true)
    expect(validateFollowupQuestion('What?\n')).toBe(true)
  })

  it('rejects empty, whitespace-only, and non-question output', () => {
    expect(validateFollowupQuestion('')).toBe(false)
    expect(validateFollowupQuestion('   ')).toBe(false)
    expect(validateFollowupQuestion('I wonder whether the walk helped')).toBe(false)
    expect(validateFollowupQuestion('What made today better')).toBe(false)
  })
})

describe('generateFollowUpQuestion — one validated, grounded question (Task A)', () => {
  it('returns the trimmed question and the referenced previous-entry ids from a valid reply', async () => {
    generateFollowUpSpy = vi
      .spyOn(modelClient, 'generateFollowUp')
      .mockResolvedValue('  Did the morning walk help you untangle the traversal?  ')

    const result = await generateFollowUpQuestion({
      entryContent: 'Spent the morning stuck on the call-graph traversal.',
      previousEntries: PREVIOUS_ENTRIES,
    })

    expect(result).toEqual({
      text: 'Did the morning walk help you untangle the traversal?',
      referencedEntryIds: ['prev-1', 'prev-2'],
    })
    // A valid reply needs no retry.
    expect(generateFollowUpSpy).toHaveBeenCalledTimes(1)
  })

  it('grounds the context in the current entry plus at most FOLLOWUP_MAX_REFERENCED_ENTRIES previous entries', async () => {
    generateFollowUpSpy = vi
      .spyOn(modelClient, 'generateFollowUp')
      .mockResolvedValue('What felt best about the river walk?')

    await generateFollowUpQuestion({
      entryContent: 'Today the river finally felt like home.',
      previousEntries: PREVIOUS_ENTRIES,
    })

    const context = generateFollowUpSpy.mock.calls[0][0]
    expect(context).toContain('CURRENT ENTRY:\nToday the river finally felt like home.')
    // Only the two most recent previous entries are grounded in (bounded).
    expect(context).toContain("RECENT (Sunday's entry):\nThe river walk at dawn, quiet and cold.")
    expect(context).toContain("RECENT (Saturday's entry):\nWork was a blur of meetings again.")
    expect(context).not.toContain('This third entry must never reach the model.')
  })

  it('returns referencedEntryIds from exactly the passed previous entries (bounded to 2)', async () => {
    generateFollowUpSpy = vi
      .spyOn(modelClient, 'generateFollowUp')
      .mockResolvedValue('What felt best about the river walk?')

    const result = await generateFollowUpQuestion({
      entryContent: 'Today the river finally felt like home.',
      previousEntries: PREVIOUS_ENTRIES,
    })

    expect(FOLLOWUP_MAX_REFERENCED_ENTRIES).toBe(2)
    expect(result.referencedEntryIds).toEqual(['prev-1', 'prev-2'])
  })

  it('retries exactly once at the hotter temperature when the first output lacks a "?"', async () => {
    generateFollowUpSpy = vi.spyOn(modelClient, 'generateFollowUp')
    generateFollowUpSpy
      .mockResolvedValueOnce('I wonder whether the walk helped you feel better')
      .mockResolvedValueOnce('Did the walk help you feel better?')

    const result = await generateFollowUpQuestion({
      entryContent: 'The walk left me lighter.',
      previousEntries: PREVIOUS_ENTRIES,
    })

    // Exactly ONE retry (spike G2), and the retry runs at the hotter spike
    // C2 temperature — the first call uses the shell default (no override).
    expect(generateFollowUpSpy).toHaveBeenCalledTimes(2)
    expect(generateFollowUpSpy.mock.calls[1][1]).toEqual({ temperature: FOLLOWUP_RETRY_TEMPERATURE })
    expect(result.text).toBe('Did the walk help you feel better?')
  })

  it('fails loudly after two non-question outputs — the caller drops the follow-up, never blocks a save', async () => {
    generateFollowUpSpy = vi.spyOn(modelClient, 'generateFollowUp')
    generateFollowUpSpy
      .mockResolvedValueOnce('no question mark here')
      .mockResolvedValueOnce('still no question mark')

    await expect(
      generateFollowUpQuestion({
        entryContent: 'A heavy day.',
        previousEntries: [],
      }),
    ).rejects.toThrow('Follow-up generation failed: the model did not produce a question')

    // Exactly two attempts: one generation + one retry, never a loop.
    expect(generateFollowUpSpy).toHaveBeenCalledTimes(2)
  })
})

describe('assembleFollowupContext — bounded, labeled grounding (D6)', () => {
  it('bounds each referenced entry to FOLLOWUP_REFERENCE_MAX_CHARS with an ellipsis', () => {
    const longContent = 'x'.repeat(FOLLOWUP_REFERENCE_MAX_CHARS + 200)
    const context = assembleFollowupContext({
      entryContent: 'short current entry',
      previousEntries: [{ id: 'p1', content: longContent, createdAt: '2026-08-16T09:30:00.000Z' }],
    })

    expect(context).toContain(`${'x'.repeat(FOLLOWUP_REFERENCE_MAX_CHARS)}…`)
    // The tail beyond the bound never reaches the model.
    expect(context).not.toContain('x'.repeat(FOLLOWUP_REFERENCE_MAX_CHARS + 100))
  })

  it('omits the earlier-entries section entirely when there are no previous entries', () => {
    const context = assembleFollowupContext({ entryContent: 'Just today.', previousEntries: [] })
    expect(context).toBe('CURRENT ENTRY:\nJust today.')
    expect(context).not.toContain('EARLIER ENTRIES')
  })

  it('falls back to "earlier" when a previous entry has no label', () => {
    const context = assembleFollowupContext({
      entryContent: 'Just today.',
      previousEntries: [{ id: 'p1', content: 'older note', createdAt: '2026-08-10T09:30:00.000Z' }],
    })
    expect(context).toContain('RECENT (earlier):\nolder note')
  })
})
