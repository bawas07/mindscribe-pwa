/**
 * W11 — rolling summary: generation (encrypted roundtrip, validation, 1
 * retry, prior-preservation), cadence (T1), the fire-and-forget scheduler
 * (never rejects, single-flight guard, delete-always / save-cadence) and
 * getThemes. CI-clean: the real model is never loaded — `generateThemes` on
 * the shared client is mocked at the seam summary.ts calls.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { decryptText, encryptText, getOrCreateDeviceKey } from '../../db/crypto'
import { db, ROLLING_SUMMARY_ROW_ID } from '../../db/schema'
import { modelClient } from '../wllama-client'
import {
  getThemes,
  isRegenerationDue,
  parseThemesOutput,
  regenerateSummary,
  scheduleSummaryRegeneration,
  SUMMARY_REGENERATION_DAYS,
  SUMMARY_REGENERATION_NEW_ENTRIES,
} from '../summary'
import type { Theme } from '../themes'

const MS_PER_DAY = 86_400_000
// Fixed "now" for direct regenerateSummary() calls. All seeded entry dates
// are relative to this, so results are deterministic.
const NOW = new Date(2026, 7, 17, 12, 0, 0)

function isoDaysAgo(daysAgo: number): string {
  return new Date(2026, 7, 17 - daysAgo, 9, 30).toISOString()
}

async function seedEntry(id: string, content: string, daysAgo: number): Promise<void> {
  const key = await getOrCreateDeviceKey()
  await db.entries.add({
    id,
    createdAt: isoDaysAgo(daysAgo),
    contentEncrypted: await encryptText(key, content),
    moodEmoji: '',
    hasFollowup: false,
  })
}

async function seedSummary(themes: Theme[], generatedAt: string, sourceEntryCount: number): Promise<void> {
  const key = await getOrCreateDeviceKey()
  await db.rollingSummary.put({
    id: ROLLING_SUMMARY_ROW_ID,
    generatedAt,
    themesEncrypted: await encryptText(key, JSON.stringify(themes)),
    sourceEntryCount,
  })
}

/** Decrypts the current summary row; returns null when no row exists. */
async function readCurrentSummary(): Promise<{ themes: Theme[]; generatedAt: string; sourceEntryCount: number } | null> {
  const row = await db.rollingSummary.get(ROLLING_SUMMARY_ROW_ID)
  if (!row) return null
  const key = await getOrCreateDeviceKey()
  return {
    themes: JSON.parse(await decryptText(key, row.themesEncrypted)) as Theme[],
    generatedAt: row.generatedAt,
    sourceEntryCount: row.sourceEntryCount,
  }
}

let generateThemesSpy: ReturnType<typeof vi.spyOn>
let statusSpy: ReturnType<typeof vi.spyOn>

beforeEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(db.tables.map((table) => table.clear()))
  // Default: the model is already loaded, so the scheduler proceeds. Individual
  // tests override this to prove the deferral path (never silent-download).
  statusSpy = vi
    .spyOn(modelClient, 'getModelStatus')
    .mockReturnValue({ state: 'ready' } as ReturnType<typeof modelClient.getModelStatus>)
})

/** Stub the model at the seam summary.ts calls. */
function mockGenerateThemes(output: string): void {
  generateThemesSpy = vi.spyOn(modelClient, 'generateThemes').mockResolvedValue(output)
}

describe('regenerateSummary — generation + encrypted persistence (C1)', () => {
  it('writes an encrypted row and computes counts/days app-side from a valid themes-only model reply', async () => {
    await seedEntry('e1', 'went for a river walk', 0)
    await seedEntry('e2', 'river walk again', 2)
    await seedEntry('e3', 'work was busy', 3)
    mockGenerateThemes('{"themes":["work","river walk"]}')

    await regenerateSummary('save', NOW)

    const summary = await readCurrentSummary()
    expect(summary).not.toBeNull()
    expect(summary?.generatedAt).toBe(NOW.toISOString())
    expect(summary?.sourceEntryCount).toBe(3)
    // The model gave NO numbers — the matcher owns them (spike C1).
    expect(summary?.themes).toEqual([
      { topic: 'river walk', lastMentionedDaysAgo: 0, mentionCount: 2 },
      { topic: 'work', lastMentionedDaysAgo: 3, mentionCount: 1 },
    ])
    // The stored blob is encrypted, never the raw JSON.
    const row = await db.rollingSummary.get(ROLLING_SUMMARY_ROW_ID)
    expect(row?.themesEncrypted.byteLength).toBeGreaterThan(12)
    expect(new TextDecoder().decode(new Uint8Array(row!.themesEncrypted))).not.toContain('river walk')
  })

  it('keeps a single upserted row when regenerated', async () => {
    await seedEntry('e1', 'work today', 0)
    mockGenerateThemes('{"themes":["work"]}')
    await regenerateSummary('save', NOW)
    await regenerateSummary('entry-deleted', NOW)
    expect(await db.rollingSummary.count()).toBe(1)
  })

  it('retries once on malformed output, then succeeds on the second attempt', async () => {
    await seedEntry('e1', 'work was busy', 0)
    mockGenerateThemes('not json at all')
    generateThemesSpy.mockResolvedValueOnce('not json at all').mockResolvedValueOnce('{"themes":["work"]}')

    await regenerateSummary('save', NOW)

    expect(generateThemesSpy).toHaveBeenCalledTimes(2) // 1 retry
    const summary = await readCurrentSummary()
    expect(summary?.themes).toEqual([{ topic: 'work', lastMentionedDaysAgo: 0, mentionCount: 1 }])
  })

  it('after malformed-then-malformed, keeps the previous summary intact and never throws', async () => {
    const prior: Theme[] = [{ topic: 'old themes', lastMentionedDaysAgo: 1, mentionCount: 3 }]
    await seedSummary(prior, NOW.toISOString(), 2)
    await seedEntry('e1', 'work was busy', 0)
    mockGenerateThemes('garbage output, twice')
    generateThemesSpy
      .mockResolvedValueOnce('garbage output, twice')
      .mockResolvedValueOnce('garbage output, twice')

    await expect(regenerateSummary('save', NOW)).resolves.toBeUndefined()

    expect(generateThemesSpy).toHaveBeenCalledTimes(2)
    const summary = await readCurrentSummary()
    expect(summary?.themes).toEqual(prior) // prior summary untouched
    expect(summary?.generatedAt).toBe(NOW.toISOString())
    expect(summary?.sourceEntryCount).toBe(2)
  })

  it('never writes an empty summary when every returned theme matches nothing (leak/hallucination)', async () => {
    await seedEntry('e1', 'nothing to do with piers', 0)
    mockGenerateThemes('{"themes":["harbor visits"]}') // leaked example term
    generateThemesSpy.mockResolvedValue('{"themes":["harbor visits"]}')

    await regenerateSummary('save', NOW)

    expect(await db.rollingSummary.count()).toBe(0)
    expect(generateThemesSpy.mock.calls.length).toBeGreaterThanOrEqual(1)
  })

  it('slides to an empty journal: clears any stale summary without touching the model', async () => {
    await seedSummary([{ topic: 'gone', lastMentionedDaysAgo: 0, mentionCount: 1 }], NOW.toISOString(), 1)
    mockGenerateThemes('{"themes":["never reached"]}')

    await regenerateSummary('entry-deleted', NOW)

    expect(await db.rollingSummary.count()).toBe(0)
    expect(generateThemesSpy).not.toHaveBeenCalled()
  })

  it('survives a model failure (not downloaded / load error) — non-fatal, prior intact', async () => {
    await seedSummary([{ topic: 'kept', lastMentionedDaysAgo: 0, mentionCount: 2 }], NOW.toISOString(), 1)
    await seedEntry('e1', 'work today', 0)
    generateThemesSpy = vi.spyOn(modelClient, 'generateThemes').mockRejectedValue(new Error('model unavailable'))

    await expect(regenerateSummary('save', NOW)).resolves.toBeUndefined()

    expect((await readCurrentSummary())?.themes[0].topic).toBe('kept')
  })
})

describe('parseThemesOutput — strict JSON contract (spike §5/G8)', () => {
  it('accepts a plain single-key themes object', () => {
    expect(parseThemesOutput('{"themes":["river walks","work"]}')).toEqual(['river walks', 'work'])
  })

  it('strips a code fence even though the prompt bans one', () => {
    expect(parseThemesOutput('```json\n{"themes":["work"]}\n```')).toEqual(['work'])
    expect(parseThemesOutput('```\n{"themes":["work"]}\n```')).toEqual(['work'])
  })

  it('rejects extra keys, non-objects, non-array themes and non-string topics', () => {
    expect(parseThemesOutput('{"themes":["work"],"counts":[1]}')).toBeNull()
    expect(parseThemesOutput('{"topic":"work"}')).toBeNull()
    expect(parseThemesOutput('[]')).toBeNull()
    expect(parseThemesOutput('null')).toBeNull()
    expect(parseThemesOutput('"plain string"')).toBeNull()
    expect(parseThemesOutput('{"themes":[1,2]}')).toBeNull()
    expect(parseThemesOutput('{"themes":[["work"]]}')).toBeNull()
  })

  it('rejects the duplicate-key leak the spike observed, and empty topics', () => {
    expect(parseThemesOutput('{"themes":["river walk"],"themes":["harbor visits"]}')).toBeNull()
    expect(parseThemesOutput('{"themes":["", "   "]}')).toBeNull()
    expect(parseThemesOutput('{"themes":[]}')).toBeNull()
  })

  it('trims topic whitespace', () => {
    expect(parseThemesOutput('{"themes":["  work  "]}')).toEqual(['work'])
  })
})

describe('isRegenerationDue — cadence thresholds (decision T1)', () => {
  const now = new Date(2026, 7, 17, 12)
  const todayIso = now.toISOString()
  const oldIso = new Date(2026, 7, 17 - SUMMARY_REGENERATION_DAYS, 12).toISOString() // exactly 7 days

  it('generates when there is no summary yet', () => {
    expect(isRegenerationDue(now, null, 0, 0)).toBe(true)
  })

  it('regenerates at exactly 7 days, but not before', () => {
    expect(isRegenerationDue(now, oldIso, 5, 5)).toBe(true)
    const sixDays = new Date(2026, 7, 17 - (SUMMARY_REGENERATION_DAYS - 1), 12).toISOString()
    expect(isRegenerationDue(now, sixDays, 5, 5)).toBe(false)
  })

  it('regenerates at exactly 5 new entries, but not fewer', () => {
    // Recent summary (1 day old) so only the entry-count rule is in play.
    const generated = new Date(2026, 7, 16, 12).toISOString()
    expect(isRegenerationDue(now, generated, 0, SUMMARY_REGENERATION_NEW_ENTRIES)).toBe(true)
    expect(isRegenerationDue(now, generated, 0, SUMMARY_REGENERATION_NEW_ENTRIES - 1)).toBe(false)
  })

  it('regenerates when entries were DELETED since the summary (negative delta → stale)', () => {
    // Recent summary, but the journal shrank below sourceEntryCount — a delete
    // that was deferred while the model was unloaded. The stale summary must
    // not linger until the 7-day rule (W11 gate should-fix).
    const generated = todayIso
    expect(isRegenerationDue(now, generated, 10, 9)).toBe(true)
    expect(isRegenerationDue(now, generated, 10, 0)).toBe(true)
  })

  it('returns false when neither threshold is met, true when both are', () => {
    const generated = todayIso
    expect(isRegenerationDue(now, generated, 10, 10)).toBe(false)
    expect(isRegenerationDue(now, oldIso, 0, SUMMARY_REGENERATION_NEW_ENTRIES)).toBe(true)
  })
})

describe('scheduleSummaryRegeneration — fire-and-forget scheduler', () => {
  it('does NOT load the model in the background when it is not already ready (no silent download)', async () => {
    await seedEntry('e1', 'river walk today', 0)
    mockGenerateThemes('{"themes":["river walk"]}')
    statusSpy.mockReturnValue({ state: 'unloaded' } as ReturnType<typeof modelClient.getModelStatus>)

    await scheduleSummaryRegeneration('entry-deleted')
    await scheduleSummaryRegeneration('save')

    // The regen defers — the model must never be force-loaded by a save/delete.
    expect(generateThemesSpy).not.toHaveBeenCalled()
    expect(await db.rollingSummary.count()).toBe(0)
  })

  it('never rejects (fire-and-forget per the W7 gate note)', async () => {
    await seedEntry('e1', 'work today', 0)
    mockGenerateThemes('{"themes":["work"]}')

    await expect(scheduleSummaryRegeneration('entry-deleted')).resolves.toBeUndefined()
    expect((await readCurrentSummary())?.themes[0].topic).toBe('work')
  })

  it('coalesces concurrent calls into a single regeneration (in-flight guard)', async () => {
    await seedEntry('e1', 'work today', 0)
    mockGenerateThemes('{"themes":["work"]}')

    const first = scheduleSummaryRegeneration('entry-deleted')
    const second = scheduleSummaryRegeneration('entry-deleted')
    await Promise.all([first, second])

    expect(generateThemesSpy).toHaveBeenCalledTimes(1)
    expect(await db.rollingSummary.count()).toBe(1)
  })

  it('entry delete always regenerates', async () => {
    await seedEntry('e1', 'work today', 0)
    mockGenerateThemes('{"themes":["work"]}')

    await scheduleSummaryRegeneration('entry-deleted')

    expect(generateThemesSpy).toHaveBeenCalledTimes(1)
    expect(await readCurrentSummary()).not.toBeNull()
  })

  it('save respects cadence: does not regenerate when nothing is due', async () => {
    // Recent summary (generated "just now") covering the current journal.
    await seedEntry('e1', 'work today', 0)
    await seedEntry('e2', 'rest', 1)
    await seedSummary([{ topic: 'work', lastMentionedDaysAgo: 0, mentionCount: 1 }], new Date().toISOString(), 2)
    mockGenerateThemes('{"themes":["work"]}')

    await scheduleSummaryRegeneration('save')

    expect(generateThemesSpy).not.toHaveBeenCalled()
    const summary = await readCurrentSummary()
    expect(summary?.sourceEntryCount).toBe(2)
  })

  it('save regenerates when the summary is >=7 days old', async () => {
    await seedEntry('e1', 'work today', 0)
    const tenDaysAgo = new Date(Date.now() - 10 * MS_PER_DAY).toISOString()
    await seedSummary([{ topic: 'stale', lastMentionedDaysAgo: 9, mentionCount: 1 }], tenDaysAgo, 1)
    mockGenerateThemes('{"themes":["work"]}')

    await scheduleSummaryRegeneration('save')

    expect(generateThemesSpy).toHaveBeenCalledTimes(1)
    expect((await readCurrentSummary())?.themes[0].topic).toBe('work')
  })

  it('save regenerates when >=5 new entries exist since the last summary', async () => {
    // 5 entries all containing "work", but the summary claims it covered 0.
    for (let index = 0; index < SUMMARY_REGENERATION_NEW_ENTRIES; index++) {
      await seedEntry(`e${index}`, `lots of work on day ${index}`, index)
    }
    await seedSummary([{ topic: 'old', lastMentionedDaysAgo: 0, mentionCount: 1 }], new Date().toISOString(), 0)
    mockGenerateThemes('{"themes":["work"]}')

    await scheduleSummaryRegeneration('save')

    expect(generateThemesSpy).toHaveBeenCalledTimes(1)
  })
})

describe('getThemes — W9 seam', () => {
  it('returns [] cleanly when no summary exists yet', async () => {
    await seedEntry('e1', 'work today', 0)
    expect(await getThemes()).toEqual([])
  })

  it('returns the decrypted themes, most-recent-sorted, when a summary exists', async () => {
    await seedSummary(
      [
        { topic: 'river walk', lastMentionedDaysAgo: 0, mentionCount: 2 },
        { topic: 'work', lastMentionedDaysAgo: 3, mentionCount: 1 },
      ],
      NOW.toISOString(),
      3,
    )
    expect(await getThemes()).toEqual([
      { topic: 'river walk', lastMentionedDaysAgo: 0, mentionCount: 2 },
      { topic: 'work', lastMentionedDaysAgo: 3, mentionCount: 1 },
    ])
  })

  it('returns [] on a corrupt/unreadable row (never throws)', async () => {
    await db.rollingSummary.put({
      id: ROLLING_SUMMARY_ROW_ID,
      generatedAt: NOW.toISOString(),
      themesEncrypted: new TextEncoder().encode('not an encrypted blob').buffer, // garbage
      sourceEntryCount: 1,
    })
    expect(await getThemes()).toEqual([])
  })
})
