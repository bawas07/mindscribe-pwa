/**
 * W10 — follow-up persistence + opt-in trigger rule.
 *
 * Pure rules (isFollowupWorthy / canAskFollowup) and the write side
 * (createFollowupResponse) through the real repo path: encrypted question +
 * response at rest, skip stored as an empty encrypted string that the read
 * side maps back to null, hasFollowup flipped in the SAME transaction, and
 * the failure modes (missing entry / empty question). No model involved —
 * entries are seeded via createEntry, whose summary regen defers while the
 * client is unloaded (the real 657 MB model is never loaded).
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { decryptText, getOrCreateDeviceKey } from '../db/crypto'
import { db, type Entry } from '../db/schema'
import { createEntry, listFollowupsForEntry } from '../entries'
import {
  canAskFollowup,
  createFollowupResponse,
  FOLLOWUP_MAX_QUESTIONS,
  FOLLOWUP_WORTHY_MIN_LENGTH,
  isFollowupWorthy,
} from '../followups'

beforeEach(async () => {
  // Clean slate per test; same pattern as the other db suites.
  await Promise.all(db.tables.map((table) => table.clear()))
})

describe('isFollowupWorthy — the opt-in trigger (decision T2)', () => {
  it('is false for empty and whitespace-only content', () => {
    expect(isFollowupWorthy('')).toBe(false)
    expect(isFollowupWorthy('   ')).toBe(false)
    expect(isFollowupWorthy('\n\t  \n')).toBe(false)
  })

  it('is false just below the floor and true at exactly FOLLOWUP_WORTHY_MIN_LENGTH', () => {
    // The floor is 1: any non-empty entry qualifies. The opt-in is
    // user-initiated (D5), so the old 40-char heuristic was removed — it made
    // the feature feel broken on short, realistic entries (real journal
    // entries are often one line).
    expect(FOLLOWUP_WORTHY_MIN_LENGTH).toBe(1)
    expect(isFollowupWorthy('a'.repeat(39))).toBe(true)
    expect(isFollowupWorthy('Biked 20k.')).toBe(true)
  })

  it('is true for longer content and ignores surrounding whitespace', () => {
    expect(isFollowupWorthy('a'.repeat(120))).toBe(true)
    expect(isFollowupWorthy(`  \n${'a'.repeat(3)}\n  `)).toBe(true)
  })
})

describe('canAskFollowup — the strict session cap (decision T2)', () => {
  it('allows while under the cap and stops at exactly FOLLOWUP_MAX_QUESTIONS', () => {
    expect(FOLLOWUP_MAX_QUESTIONS).toBe(2)
    expect(canAskFollowup(0)).toBe(true)
    expect(canAskFollowup(1)).toBe(true)
    expect(canAskFollowup(2)).toBe(false)
    expect(canAskFollowup(3)).toBe(false)
  })
})

describe('createFollowupResponse — encrypted write side (W10)', () => {
  async function seedEntry(content = 'Spent the morning stuck on the call-graph traversal.'): Promise<string> {
    return createEntry({ content, moodEmoji: '🙂' })
  }

  it('persists question + response encrypted at rest and flips hasFollowup in the same write', async () => {
    const entryId = await seedEntry()

    await createFollowupResponse({
      entryId,
      question: 'What did you find most refreshing about stepping away from the call-graph?',
      response: 'The coffee break — the code untangled itself mid-pour.',
      referencedEntryIds: [],
    })

    const row = await db.followupResponses.where('entryId').equals(entryId).first()
    expect(row).toBeDefined()
    expect(row?.referencedEntryIds).toEqual([])

    // Encrypted at rest: the stored blobs never contain the plaintext…
    const storedQuestion = new TextDecoder().decode(new Uint8Array(row!.questionEncrypted))
    const storedResponse = new TextDecoder().decode(new Uint8Array(row!.responseEncrypted))
    expect(storedQuestion).not.toContain('refreshing')
    expect(storedResponse).not.toContain('coffee break')

    // …and the device key round-trips both back to exactly what was saved.
    const key = await getOrCreateDeviceKey()
    expect(await decryptText(key, row!.questionEncrypted)).toBe(
      'What did you find most refreshing about stepping away from the call-graph?',
    )
    expect(await decryptText(key, row!.responseEncrypted)).toBe(
      'The coffee break — the code untangled itself mid-pour.',
    )

    // The entry flag flips in the same transaction (W10 contract).
    const entry = (await db.entries.get(entryId)) as Entry
    expect(entry.hasFollowup).toBe(true)
  })

  it('stores a skipped question as an empty encrypted string, which the read side maps to null', async () => {
    const entryId = await seedEntry()

    await createFollowupResponse({
      entryId,
      question: 'Did the river walk help?',
      response: null,
      referencedEntryIds: [],
    })

    const key = await getOrCreateDeviceKey()
    const row = await db.followupResponses.where('entryId').equals(entryId).first()
    expect(await decryptText(key, row!.responseEncrypted)).toBe('')

    // The read-side contract: the row EXISTS (the question was asked) but
    // the response surfaces as null — never an empty string.
    const followups = await listFollowupsForEntry(entryId)
    expect(followups).toHaveLength(1)
    expect(followups[0].question).toBe('Did the river walk help?')
    expect(followups[0].response).toBeNull()
    expect((await db.entries.get(entryId))?.hasFollowup).toBe(true)
  })

  it('persists two follow-ups for one entry, both readable in ask order (Q1 before Q2)', async () => {
    const entryId = await seedEntry()

    await createFollowupResponse({
      entryId,
      question: 'First question?',
      response: 'First answer.',
      referencedEntryIds: ['prev-1'],
    })
    // Distinct createdAt timestamps keep the read-side order deterministic.
    await new Promise((resolve) => setTimeout(resolve, 5))
    await createFollowupResponse({
      entryId,
      question: 'Second question?',
      response: 'Second answer.',
      referencedEntryIds: ['prev-2'],
    })

    const followups = await listFollowupsForEntry(entryId)
    expect(followups.map((followup) => followup.question)).toEqual(['First question?', 'Second question?'])
    expect(followups.map((followup) => followup.response)).toEqual(['First answer.', 'Second answer.'])
    expect(followups.map((followup) => followup.referencedEntryIds)).toEqual([['prev-1'], ['prev-2']])

    // Both rows persist and the entry flag is set once.
    expect(await db.followupResponses.where('entryId').equals(entryId).count()).toBe(2)
    expect((await db.entries.get(entryId))?.hasFollowup).toBe(true)
  })

  it('throws when the owning entry does not exist — nothing is written', async () => {
    await expect(
      createFollowupResponse({
        entryId: 'missing-entry-id',
        question: 'Any question?',
        response: 'Any answer.',
        referencedEntryIds: [],
      }),
    ).rejects.toThrow('Cannot attach a follow-up to missing entry missing-entry-id')

    expect(await db.followupResponses.count()).toBe(0)
  })

  it('throws on a missing or empty question (a follow-up row must always carry one)', async () => {
    const entryId = await seedEntry()

    await expect(
      createFollowupResponse({ entryId: '', question: 'x?', response: null, referencedEntryIds: [] }),
    ).rejects.toThrow('Cannot persist a follow-up without an entryId')
    await expect(
      createFollowupResponse({ entryId, question: '', response: null, referencedEntryIds: [] }),
    ).rejects.toThrow('Cannot persist a follow-up without a question')
    await expect(
      createFollowupResponse({ entryId, question: '   \n\t ', response: null, referencedEntryIds: [] }),
    ).rejects.toThrow('Cannot persist a follow-up without a question')

    expect(await db.followupResponses.count()).toBe(0)
    expect((await db.entries.get(entryId))?.hasFollowup).toBe(false)
  })

  it('survives arbitrary unicode in the response (emoji, CJK, accents, newlines)', async () => {
    const entryId = await seedEntry()
    const unicodeResponse = 'Café ☕ 中文 🎉 — even across\n\nmultiple paragraphs, 日本語 текст survives.'

    await createFollowupResponse({
      entryId,
      question: 'What stays with you from today?',
      response: unicodeResponse,
      referencedEntryIds: [],
    })

    const key = await getOrCreateDeviceKey()
    const row = await db.followupResponses.where('entryId').equals(entryId).first()
    expect(await decryptText(key, row!.responseEncrypted)).toBe(unicodeResponse)
  })
})
