import { beforeEach, describe, expect, it } from 'vitest'
import {
  db,
  SETTINGS_ROW_ID,
  type Entry,
  type FollowupResponse,
  type RollingSummary,
  type Settings,
} from '../schema'

const JANUARY_ENTRY: Entry = {
  id: 'entry-jan',
  createdAt: '2025-01-15T08:30:00.000Z',
  contentEncrypted: new ArrayBuffer(16),
  moodEmoji: '😌',
  hasFollowup: false,
}

function makeFollowup(id: string, entryId: string): FollowupResponse {
  return {
    id,
    entryId,
    questionEncrypted: new ArrayBuffer(4),
    responseEncrypted: new ArrayBuffer(4),
    referencedEntryIds: [],
  }
}

beforeEach(async () => {
  // Clean slate per test; clearing tables keeps the same Dexie/IndexedDB
  // instance open (db.delete() would close it and block auto-reopen).
  await Promise.all(db.tables.map((table) => table.clear()))
})

describe('database schema v1', () => {
  it('creates all five tables', async () => {
    const tableNames = db.tables.map((table) => table.name).sort()
    expect(tableNames).toEqual([
      'entries',
      'followupResponses',
      'rollingSummary',
      'secrets',
      'settings',
    ])
  })

  it('inserts and reads an Entry by primary key', async () => {
    await db.entries.add(JANUARY_ENTRY)

    const loaded = await db.entries.get(JANUARY_ENTRY.id)

    expect(loaded).toBeDefined()
    expect(loaded!.id).toBe(JANUARY_ENTRY.id)
    expect(loaded!.createdAt).toBe(JANUARY_ENTRY.createdAt)
    expect(loaded!.moodEmoji).toBe('😌')
    expect(loaded!.hasFollowup).toBe(false)
    expect(new Uint8Array(loaded!.contentEncrypted)).toEqual(
      new Uint8Array(JANUARY_ENTRY.contentEncrypted),
    )
  })

  it('range-queries entries by the createdAt index (calendar month use case)', async () => {
    await db.entries.bulkAdd([
      { ...JANUARY_ENTRY, id: 'e-jan-1', createdAt: '2025-01-05T09:00:00.000Z' },
      { ...JANUARY_ENTRY, id: 'e-jan-2', createdAt: '2025-01-28T19:30:00.000Z' },
      { ...JANUARY_ENTRY, id: 'e-feb-1', createdAt: '2025-02-02T09:00:00.000Z' },
    ])

    const january = await db.entries
      .where('createdAt')
      .between('2025-01-01T00:00:00.000Z', '2025-01-31T23:59:59.999Z')
      .toArray()

    expect(january.map((entry) => entry.id)).toEqual(['e-jan-1', 'e-jan-2'])
  })

  it('queries follow-up responses by the entryId index', async () => {
    await db.followupResponses.bulkAdd([
      makeFollowup('f-1', 'entry-a'),
      makeFollowup('f-2', 'entry-b'),
      makeFollowup('f-3', 'entry-a'),
    ])

    const forEntryA = await db.followupResponses.where('entryId').equals('entry-a').toArray()

    expect(forEntryA.map((response) => response.id).sort()).toEqual(['f-1', 'f-3'])
  })

  it('stores and reads the single settings row', async () => {
    const settings: Settings = {
      id: SETTINGS_ROW_ID,
      pinEnabled: false,
      onboardingCompleted: false,
      reminderTime: null,
      reminderMode: 'off',
      lastExportAt: null,
      modelVersion: null,
    }

    await db.settings.put(settings)
    await db.settings.put({ ...settings, reminderMode: 'end_of_day' })
    const loaded = await db.settings.get(SETTINGS_ROW_ID)

    expect(loaded?.reminderMode).toBe('end_of_day')
    expect(await db.settings.count()).toBe(1) // single-row semantics survive re-puts
  })

  it('round-trips a RollingSummary row', async () => {
    const summary: RollingSummary = {
      id: 'summary-1',
      generatedAt: '2025-01-31T10:00:00.000Z',
      themesEncrypted: new ArrayBuffer(8),
      sourceEntryCount: 42,
    }

    await db.rollingSummary.put(summary)
    const loaded = await db.rollingSummary.get(summary.id)

    expect(loaded).toBeDefined()
    expect(loaded!.id).toBe(summary.id)
    expect(loaded!.generatedAt).toBe(summary.generatedAt)
    expect(loaded!.sourceEntryCount).toBe(summary.sourceEntryCount)
    expect(new Uint8Array(loaded!.themesEncrypted)).toEqual(
      new Uint8Array(summary.themesEncrypted),
    )
  })
})
