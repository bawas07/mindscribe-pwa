/**
 * Settings bootstrap + onboarding gate (plan decision T6).
 *
 * The onboarding-completed flag lives in the Settings table — the single
 * source of truth — not localStorage. Settings is a single-row table
 * (id = 'app'), so bootstrap is a get-or-create on that row.
 */
import { db, SETTINGS_ROW_ID, type Settings } from './schema'

/** Safe defaults for a fresh install: everything off, nothing set. */
function defaultSettings(): Settings {
  return {
    id: SETTINGS_ROW_ID,
    pinEnabled: false,
    onboardingCompleted: false,
    reminderTime: null,
    reminderMode: 'off',
    lastExportAt: null,
    modelVersion: null,
  }
}

/**
 * Returns the single settings row, creating it with safe defaults if
 * absent. The check-then-put runs inside one readwrite transaction, so
 * two tabs racing on first launch can't both insert the row — IndexedDB
 * serializes their transactions and the loser re-reads the winner's row
 * (same pattern as crypto.ts's device-key race closure).
 */
export async function getOrCreateSettings(): Promise<Settings> {
  return db.transaction('rw', db.settings, async () => {
    const existing = await db.settings.get(SETTINGS_ROW_ID)
    if (existing) return existing

    const fresh = defaultSettings()
    await db.settings.put(fresh)
    return fresh
  })
}

/** Marks onboarding done. No-op when already completed, so a re-tap can't harm anything. */
export async function completeOnboarding(): Promise<void> {
  const settings = await getOrCreateSettings()
  if (settings.onboardingCompleted) return

  await db.settings.update(SETTINGS_ROW_ID, { onboardingCompleted: true })
}
