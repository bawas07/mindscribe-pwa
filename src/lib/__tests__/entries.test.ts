import { beforeEach, describe, expect, it } from 'vitest'
import { encryptText, getOrCreateDeviceKey } from '../db/crypto'
import { db, type Entry } from '../db/schema'
import {
  deriveSnippet,
  deriveTitle,
  listMonthEntries,
  listRecentEntries,
  moodForDay,
  type DecryptedEntry,
} from '../entries'

/**
 * Seeds a real entry through the production crypto path (device key +
 * encryptText), so list functions exercise the actual decrypt loop.
 */
async function seedEntry(seed: {
  id: string
  createdAt: string
  content: string
  moodEmoji?: string
}): Promise<Entry> {
  const key = await getOrCreateDeviceKey()
  const entry: Entry = {
    id: seed.id,
    createdAt: seed.createdAt,
    contentEncrypted: await encryptText(key, seed.content),
    moodEmoji: seed.moodEmoji ?? '',
    hasFollowup: false,
  }
  await db.entries.add(entry)
  return entry
}

const iso = (year: number, month: number, day: number, hour = 12) =>
  new Date(year, month, day, hour, 0).toISOString()

beforeEach(async () => {
  // Clean slate per test; same pattern as the db test suites.
  await Promise.all(db.tables.map((table) => table.clear()))
})

describe('listMonthEntries / listRecentEntries (W5 read side)', () => {
  it('returns the month’s entries newest-first, decrypted, with no encrypted blob exposed', async () => {
    await seedEntry({ id: 'e-early', createdAt: iso(2026, 7, 2, 9), content: 'first line\nsecond line', moodEmoji: '🙂' })
    await seedEntry({ id: 'e-late', createdAt: iso(2026, 7, 28, 19), content: 'another day', moodEmoji: '😌' })
    await seedEntry({ id: 'e-sep', createdAt: iso(2026, 8, 1, 0), content: 'next month', moodEmoji: '😔' })

    const august = await listMonthEntries(2026, 7)

    expect(august.map((entry) => entry.id)).toEqual(['e-late', 'e-early'])
    expect(august[0].content).toBe('another day')
    expect(august[0].moodEmoji).toBe('😌')
    expect(august[0].hasFollowup).toBe(false)
    expect('contentEncrypted' in august[0]).toBe(false)
  })

  it('includes the last moment of the month and excludes the first of the next', async () => {
    await seedEntry({ id: 'e-last-minute', createdAt: iso(2026, 7, 31, 23), content: 'barely made it', moodEmoji: '😐' })
    await seedEntry({ id: 'e-first-sep', createdAt: iso(2026, 8, 1, 0), content: 'september', moodEmoji: '😔' })

    const august = await listMonthEntries(2026, 7)
    expect(august.map((entry) => entry.id)).toEqual(['e-last-minute'])
  })

  it('listRecentEntries returns newest first with the default limit of 5', async () => {
    for (let day = 1; day <= 7; day++) {
      await seedEntry({ id: `e-${day}`, createdAt: iso(2026, 7, day), content: `day ${day}`, moodEmoji: '🙂' })
    }

    const recent = await listRecentEntries()

    expect(recent.map((entry) => entry.id)).toEqual(['e-7', 'e-6', 'e-5', 'e-4', 'e-3'])
    expect(recent.every((entry) => !('contentEncrypted' in entry))).toBe(true)
    expect(recent[0].content).toBe('day 7')
  })

  it('listRecentEntries respects an explicit limit', async () => {
    for (let day = 1; day <= 4; day++) {
      await seedEntry({ id: `e-${day}`, createdAt: iso(2026, 7, day), content: `day ${day}`, moodEmoji: '🙂' })
    }

    const recent = await listRecentEntries(2)
    expect(recent.map((entry) => entry.id)).toEqual(['e-4', 'e-3'])
  })

  it('survives an empty database', async () => {
    expect(await listMonthEntries(2026, 7)).toEqual([])
    expect(await listRecentEntries()).toEqual([])
  })
})

describe('deriveTitle (first-line title, date fallback)', () => {
  const createdAt = iso(2026, 7, 17, 8)

  it('uses the first non-empty line as the title', () => {
    expect(deriveTitle('The depgraph thing finally clicked\nrest of the entry…', createdAt)).toBe(
      'The depgraph thing finally clicked',
    )
  })

  it('skips leading blank lines', () => {
    expect(deriveTitle('\n\n  Slower morning today\nmore text', createdAt)).toBe('Slower morning today')
  })

  it('trims a very long first line to ~60 chars with an ellipsis', () => {
    const longLine = 'a'.repeat(300)
    const title = deriveTitle(`${longLine}\nmore`, createdAt)

    expect(title).toHaveLength(61)
    expect(title.startsWith('a'.repeat(60))).toBe(true)
    expect(title.endsWith('…')).toBe(true)
  })

  it('falls back to a date title when content is empty', () => {
    expect(deriveTitle('', createdAt)).toBe('17 August')
  })

  it('falls back when content is only whitespace', () => {
    expect(deriveTitle(' \n\t\n ', createdAt)).toBe('17 August')
  })

  it('falls back when the only line is too short to be a title', () => {
    expect(deriveTitle('ugh\nreal content follows', createdAt)).toBe('17 August')
  })
})

describe('deriveSnippet (2-line clamp)', () => {
  it('collapses whitespace across lines', () => {
    expect(deriveSnippet('line one\n\n  line two')).toBe('line one line two')
  })

  it('caps at ~160 chars', () => {
    const snippet = deriveSnippet('word '.repeat(200))
    expect(snippet.length).toBeLessThanOrEqual(161)
  })

  it('handles empty content', () => {
    expect(deriveSnippet('')).toBe('')
  })
})

describe('moodForDay (decision T3: latest entry of the day wins)', () => {
  const entry = (id: string, createdAt: string, moodEmoji: string): DecryptedEntry => ({
    id,
    createdAt,
    moodEmoji,
    hasFollowup: false,
    content: 'decrypted by the repository',
  })

  it('returns the latest entry’s mood when a day has several', () => {
    const entries = [
      entry('a', iso(2026, 7, 6, 9), '🙂'),
      entry('b', iso(2026, 7, 6, 21), '😔'),
      entry('c', iso(2026, 7, 5, 9), '😤'),
    ]

    expect(moodForDay(entries, 6)).toBe('😔')
    expect(moodForDay(entries, 5)).toBe('😤')
  })

  it('returns null for days without entries', () => {
    expect(moodForDay([entry('a', iso(2026, 7, 6, 9), '🙂')], 7)).toBeNull()
  })

  it('returns null when the latest entry has no mood', () => {
    const entries = [entry('a', iso(2026, 7, 6, 9), ''), entry('b', iso(2026, 7, 6, 21), '')]
    expect(moodForDay(entries, 6)).toBeNull()
  })

  it('handles an empty list', () => {
    expect(moodForDay([], 1)).toBeNull()
  })
})
