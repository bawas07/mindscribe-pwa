import { beforeEach, describe, expect, it } from 'vitest'
import { db, SETTINGS_ROW_ID } from '../schema'
import { completeOnboarding, getOrCreateSettings } from '../settings'

beforeEach(async () => {
  // Clean slate per test; clearing tables keeps the same Dexie/IndexedDB
  // instance open (same pattern as schema.test.ts).
  await Promise.all(db.tables.map((table) => table.clear()))
})

describe('settings bootstrap (W4 onboarding gate)', () => {
  it('creates the app row with safe defaults when absent', async () => {
    const settings = await getOrCreateSettings()

    expect(settings).toEqual({
      id: SETTINGS_ROW_ID,
      pinEnabled: false,
      onboardingCompleted: false,
      reminderTime: null,
      reminderMode: 'off',
      lastExportAt: null,
      modelVersion: null,
    })
    expect(await db.settings.count()).toBe(1)
  })

  it('returns the same row on a second call, preserving user edits', async () => {
    await getOrCreateSettings()
    await db.settings.update(SETTINGS_ROW_ID, { reminderMode: 'end_of_day' })

    const again = await getOrCreateSettings()

    expect(again.id).toBe(SETTINGS_ROW_ID)
    expect(again.reminderMode).toBe('end_of_day')
    expect(again.onboardingCompleted).toBe(false)
    expect(await db.settings.count()).toBe(1)
  })

  it('completeOnboarding flips the flag and persists', async () => {
    await getOrCreateSettings()
    await completeOnboarding()

    const stored = await db.settings.get(SETTINGS_ROW_ID)
    expect(stored?.onboardingCompleted).toBe(true)

    // A fresh read of the same table sees the flip — it really persisted.
    const reRead = await db.settings.get(SETTINGS_ROW_ID)
    expect(reRead?.onboardingCompleted).toBe(true)
  })
})
