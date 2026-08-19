import { beforeEach, describe, expect, it } from 'vitest'
import { encryptText, getOrCreateDeviceKey } from '../db/crypto'
import { db, type Entry, type FollowupResponse } from '../db/schema'
import {
  countEntries,
  deleteEntry,
  getEntry,
  listEntrySummaries,
  listFollowupsForEntry,
} from '../entries'

/**
 * W7 repo tests — same real-crypto seeding discipline as W5/W6b: every
 * row goes through the device key + encryptText path.
 */

async function seedEntry(seed: {
  id: string
  createdAt: string
  content: string
  moodEmoji?: string
  hasFollowup?: boolean
}): Promise<Entry> {
  const key = await getOrCreateDeviceKey()
  const entry: Entry = {
    id: seed.id,
    createdAt: seed.createdAt,
    contentEncrypted: await encryptText(key, seed.content),
    moodEmoji: seed.moodEmoji ?? '',
    hasFollowup: seed.hasFollowup ?? false,
  }
  await db.entries.add(entry)
  return entry
}

async function seedFollowup(seed: {
  id: string
  entryId: string
  question: string
  response: string
  referencedEntryIds?: string[]
}): Promise<FollowupResponse> {
  const key = await getOrCreateDeviceKey()
  const row: FollowupResponse = {
    id: seed.id,
    entryId: seed.entryId,
    questionEncrypted: await encryptText(key, seed.question),
    responseEncrypted: await encryptText(key, seed.response),
    referencedEntryIds: seed.referencedEntryIds ?? [],
  }
  await db.followupResponses.add(row)
  return row
}

const iso = (year: number, month: number, day: number, hour = 12) =>
  new Date(year, month, day, hour, 0).toISOString()

beforeEach(async () => {
  await Promise.all(db.tables.map((table) => table.clear()))
})

describe('getEntry (W7 detail read)', () => {
  it('returns the decrypted entry for an existing id, without exposing the blob', async () => {
    await seedEntry({
      id: 'e-1',
      createdAt: iso(2026, 7, 17, 8),
      content: 'The depgraph thing finally clicked\nrest of the entry',
      moodEmoji: '🙂',
    })

    const entry = await getEntry('e-1')

    expect(entry).toBeDefined()
    expect(entry?.content).toBe('The depgraph thing finally clicked\nrest of the entry')
    expect(entry?.moodEmoji).toBe('🙂')
    expect(entry?.hasFollowup).toBe(false)
    expect('contentEncrypted' in (entry as object)).toBe(false)
  })

  it('returns undefined for an unknown id', async () => {
    expect(await getEntry('missing')).toBeUndefined()
  })
})

describe('listEntrySummaries (W7 month grouping)', () => {
  it('groups by month, newest month first, entries newest-first within a group', async () => {
    await seedEntry({ id: 'e-jul-early', createdAt: iso(2026, 6, 5, 9), content: 'July early', moodEmoji: '😐' })
    await seedEntry({ id: 'e-jul-late', createdAt: iso(2026, 6, 29, 19), content: 'July late', moodEmoji: '🙂' })
    await seedEntry({ id: 'e-aug-late', createdAt: iso(2026, 7, 28, 19), content: 'August late', moodEmoji: '😔' })
    await seedEntry({ id: 'e-aug-early', createdAt: iso(2026, 7, 2, 9), content: 'August early', moodEmoji: '😌' })

    const groups = await listEntrySummaries()

    expect(groups.map((group) => group.monthLabel)).toEqual(['August 2026', 'July 2026'])
    expect(groups[0].entries.map((entry) => entry.id)).toEqual(['e-aug-late', 'e-aug-early'])
    expect(groups[1].entries.map((entry) => entry.id)).toEqual(['e-jul-late', 'e-jul-early'])
  })

  it('derives title and snippet once per entry and never carries full content', async () => {
    await seedEntry({
      id: 'e-title',
      createdAt: iso(2026, 7, 17, 8),
      content: 'A real title line\nsecond line with more detail',
      moodEmoji: '🙂',
    })

    const [group] = await listEntrySummaries()
    const summary = group.entries[0]

    expect(summary.title).toBe('A real title line')
    // deriveSnippet collapses the whole content, not just the second line.
    expect(summary.snippet).toBe('A real title line second line with more detail')
    expect(summary.moodEmoji).toBe('🙂')
    expect(summary.hasFollowup).toBe(false)
    expect('content' in summary).toBe(false)
    expect('contentEncrypted' in summary).toBe(false)
  })

  it('returns an empty array for an empty journal', async () => {
    expect(await listEntrySummaries()).toEqual([])
  })
})

describe('listFollowupsForEntry (W7 follow-up read)', () => {
  it('decrypts the question + response and passes referencedEntryIds through', async () => {
    await seedEntry({ id: 'e-1', createdAt: iso(2026, 7, 17, 8), content: 'about a hike' })
    await seedFollowup({
      id: 'f-1',
      entryId: 'e-1',
      question: 'You mentioned the ridge trail again — has anything shifted?',
      response: 'It felt shorter this time.',
      referencedEntryIds: ['e-0'],
    })

    const followups = await listFollowupsForEntry('e-1')

    expect(followups).toHaveLength(1)
    expect(followups[0].question).toBe('You mentioned the ridge trail again — has anything shifted?')
    expect(followups[0].response).toBe('It felt shorter this time.')
    expect(followups[0].referencedEntryIds).toEqual(['e-0'])
  })

  it('returns an empty array when the entry has no follow-ups (W10 seam)', async () => {
    await seedEntry({ id: 'e-1', createdAt: iso(2026, 7, 17, 8), content: 'no follow-ups' })
    await seedFollowup({ id: 'f-other', entryId: 'e-other', question: 'q', response: 'r' })

    expect(await listFollowupsForEntry('e-1')).toEqual([])
  })

  it('maps a blank stored response to null (unanswered follow-up seam)', async () => {
    await seedEntry({ id: 'e-1', createdAt: iso(2026, 7, 17, 8), content: 'about a hike' })
    await seedFollowup({ id: 'f-1', entryId: 'e-1', question: 'What felt hardest?', response: '   ' })

    const followups = await listFollowupsForEntry('e-1')
    expect(followups[0].response).toBeNull()
    expect(followups[0].question).toBe('What felt hardest?')
  })
})

describe('deleteEntry (W7 delete + cascade)', () => {
  it('removes the entry and its follow-ups in one shot, and countEntries follows', async () => {
    await seedEntry({ id: 'e-1', createdAt: iso(2026, 7, 17, 8), content: 'entry with follow-ups' })
    await seedEntry({ id: 'e-2', createdAt: iso(2026, 7, 18, 8), content: 'another entry' })
    await seedFollowup({ id: 'f-1', entryId: 'e-1', question: 'q1', response: 'r1' })
    await seedFollowup({ id: 'f-2', entryId: 'e-1', question: 'q2', response: 'r2' })
    // A follow-up for a DIFFERENT entry must survive the cascade.
    await seedFollowup({ id: 'f-3', entryId: 'e-2', question: 'q3', response: 'r3' })
    expect(await countEntries()).toBe(2)

    await deleteEntry('e-1')

    expect(await db.entries.get('e-1')).toBeUndefined()
    expect(await db.entries.get('e-2')).toBeDefined()
    expect(await db.followupResponses.where('entryId').equals('e-1').count()).toBe(0)
    expect(await db.followupResponses.where('entryId').equals('e-2').count()).toBe(1)
    // T1 cadence counter stays consistent — countEntries reflects the delete.
    expect(await countEntries()).toBe(1)
  })

  it('throws a clear error for a missing id instead of silently succeeding', async () => {
    await expect(deleteEntry('missing')).rejects.toThrow('Entry missing not found')
  })

  it('leaves no rows behind after deleting an entry without follow-ups', async () => {
    await seedEntry({ id: 'e-1', createdAt: iso(2026, 7, 17, 8), content: 'plain entry' })

    await deleteEntry('e-1')

    expect(await db.entries.count()).toBe(0)
    expect(await db.followupResponses.count()).toBe(0)
  })
})