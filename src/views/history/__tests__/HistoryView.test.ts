import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createMemoryHistory, createRouter, type Router } from 'vue-router'
import HistoryView from '../HistoryView.vue'
import { routes } from '../../../router'
import { encryptText, getOrCreateDeviceKey } from '../../../lib/db/crypto'
import { db } from '../../../lib/db/schema'
import * as entriesModule from '../../../lib/entries'
import * as summaryModule from '../../../lib/model/summary'

let router: Router
let wrapper: VueWrapper

async function mountView() {
  router = createRouter({ history: createMemoryHistory(), routes })
  router.push('/history')
  await router.isReady()
  wrapper = mount(HistoryView, { global: { plugins: [router] } })
  await flushPromises()
}

/**
 * The repo read settles through IndexedDB + Web Crypto async turns that a
 * single flushPromises doesn't cover — poll until the seeded rows render
 * (same vi.waitFor pattern as the W6b tests).
 */
async function waitForRows(count: number) {
  await vi.waitFor(() => {
    expect(wrapper.findAll('.entry-row')).toHaveLength(count)
  })
}

async function seedEntry(seed: {
  id: string
  createdAt: string
  content: string
  moodEmoji?: string
}): Promise<void> {
  const key = await getOrCreateDeviceKey()
  await db.entries.add({
    id: seed.id,
    createdAt: seed.createdAt,
    contentEncrypted: await encryptText(key, seed.content),
    moodEmoji: seed.moodEmoji ?? '',
    hasFollowup: false,
  })
}

async function seedFollowup(seed: {
  id: string
  entryId: string
  question: string
  response: string
}): Promise<void> {
  const key = await getOrCreateDeviceKey()
  await db.followupResponses.add({
    id: seed.id,
    entryId: seed.entryId,
    questionEncrypted: await encryptText(key, seed.question),
    responseEncrypted: await encryptText(key, seed.response),
    referencedEntryIds: [],
  })
}

const iso = (year: number, month: number, day: number, hour = 12) =>
  new Date(year, month, day, hour, 0).toISOString()

function rowByTitle(title: string) {
  const row = wrapper
    .findAll('.entry-row')
    .find((candidate) => candidate.find('.entry-title').text() === title)
  if (!row) throw new Error(`No row for "${title}"`)
  return row
}

beforeEach(async () => {
  await Promise.all(db.tables.map((table) => table.clear()))
})

afterEach(() => {
  wrapper?.unmount()
  vi.restoreAllMocks()
})

describe('HistoryView (W7) — month grouping + rows (frame 08)', () => {
  it('renders month groups (newest first) with mood, title, snippet and date per row', async () => {
    await seedEntry({
      id: 'e-aug',
      createdAt: iso(2026, 7, 17, 8),
      content: 'The depgraph thing finally clicked\nrest of the entry',
      moodEmoji: '🙂',
    })
    await seedEntry({
      id: 'e-jul',
      createdAt: iso(2026, 6, 29, 21),
      content: 'Slower morning today\nTook the kid up the ridge trail.',
      moodEmoji: '😌',
    })

    await mountView()
    await waitForRows(2)

    const labels = wrapper.findAll('.history-month-label').map((label) => label.text())
    expect(labels).toEqual(['August 2026', 'July 2026'])

    const rows = wrapper.findAll('.entry-row')
    expect(rows).toHaveLength(2)
    const augustRow = rows[0]
    expect(augustRow.find('.entry-mood').text()).toBe('🙂')
    expect(augustRow.find('.entry-title').text()).toBe('The depgraph thing finally clicked')
    // deriveSnippet collapses the whole content into the 2-line clamp source.
    expect(augustRow.find('.entry-snippet').text()).toBe(
      'The depgraph thing finally clicked rest of the entry',
    )
    expect(augustRow.find('.entry-date').text()).toBe('AUG 17 · 08:00')
    expect(augustRow.find('.entry-delete').exists()).toBe(true)
  })

  it('shows the empty state for an empty journal', async () => {
    await mountView()
    expect(wrapper.find('.empty-note').text()).toContain('Nothing here yet')
  })

  it('navigates to /history/:id when a row is clicked', async () => {
    await seedEntry({
      id: 'e-aug',
      createdAt: iso(2026, 7, 17, 8),
      content: 'clickable row',
      moodEmoji: '🙂',
    })

    await mountView()
    await waitForRows(1)
    await wrapper.find('.entry-row').trigger('click')

    // router.push is async — wait for the navigation to be reflected.
    await vi.waitFor(() => {
      expect(router.currentRoute.value.path).toBe('/history/e-aug')
    })
  })
})

describe('HistoryView (W7) — clientside search', () => {
  it('filters rows by title and snippet, case-insensitively, and hides empty groups', async () => {
    await seedEntry({
      id: 'e-aug',
      createdAt: iso(2026, 7, 17, 8),
      content: 'The depgraph thing finally clicked\ncall-graph notes',
      moodEmoji: '🙂',
    })
    await seedEntry({
      id: 'e-jul',
      createdAt: iso(2026, 6, 29, 21),
      content: 'Slower morning today\nridge trail walk',
      moodEmoji: '😌',
    })

    await mountView()
    await waitForRows(2)
    expect(wrapper.findAll('.entry-row')).toHaveLength(2)

    // Search hits the second entry via its snippet, first via its title.
    await wrapper.find('.history-search').setValue('ridge')
    await flushPromises()
    expect(wrapper.findAll('.entry-row')).toHaveLength(1)
    expect(wrapper.find('.entry-title').text()).toBe('Slower morning today')

    await wrapper.find('.history-search').setValue('DEPGRAPH')
    await flushPromises()
    expect(wrapper.findAll('.entry-row')).toHaveLength(1)
    expect(wrapper.find('.entry-title').text()).toBe('The depgraph thing finally clicked')

    // A miss clears the groups and shows the no-match note.
    await wrapper.find('.history-search').setValue('zzz')
    await flushPromises()
    expect(wrapper.findAll('.entry-row')).toHaveLength(0)
    expect(wrapper.find('.empty-note').text()).toContain('No entries match')
  })
})

describe('HistoryView (W7) — delete + regen seam', () => {
  it('confirms inline, deletes the entry + cascaded follow-ups, re-renders, and schedules the W11 regen seam', async () => {
    await seedEntry({
      id: 'e-keep',
      createdAt: iso(2026, 7, 10, 8),
      content: 'stays',
      moodEmoji: '🙂',
    })
    await seedEntry({
      id: 'e-gone',
      createdAt: iso(2026, 7, 17, 8),
      content: 'doomed entry',
      moodEmoji: '😔',
    })
    await seedFollowup({ id: 'f-1', entryId: 'e-gone', question: 'q', response: 'r' })
    const regenSpy = vi.spyOn(summaryModule, 'scheduleSummaryRegeneration')

    await mountView()
    await waitForRows(2)
    expect(wrapper.findAll('.entry-row')).toHaveLength(2)

    // ✕ opens the inline confirm (no window.confirm); row still present.
    const row = rowByTitle('doomed entry')
    await row.find('.entry-delete').trigger('click')
    expect(row.find('.delete-confirm').exists()).toBe(true)

    // The confirm bar must not navigate when its buttons are clicked.
    await row.find('.confirm-yes').trigger('click')
    await flushPromises()

    // Row re-rendered away; other rows untouched.
    await vi.waitFor(() => {
      expect(wrapper.findAll('.entry-row')).toHaveLength(1)
    })
    expect(wrapper.find('.entry-title').text()).toBe('stays')

    // Cascade visible at the DB level + the counter decremented.
    expect(await db.entries.get('e-gone')).toBeUndefined()
    expect(await db.entries.get('e-keep')).toBeDefined()
    expect(await db.followupResponses.where('entryId').equals('e-gone').count()).toBe(0)

    // W7→W11 seam: the view schedules regen after a successful delete.
    expect(regenSpy).toHaveBeenCalledTimes(1)
    expect(regenSpy).toHaveBeenCalledWith('entry-deleted')
  })

  it('a failed delete keeps the list visible, is dismissible, and Retry can complete the delete', async () => {
    await seedEntry({
      id: 'e-gone',
      createdAt: iso(2026, 7, 17, 8),
      content: 'doomed once',
      moodEmoji: '😔',
    })
    await seedFollowup({ id: 'f-1', entryId: 'e-gone', question: 'q', response: 'r' })

    // First two attempts fail; the third runs the real deletion (so DB-level
    // cascade is verifiable) while the seam still gets signaled on success.
    const realDelete = entriesModule.deleteEntry
    const deleteSpy = vi
      .spyOn(entriesModule, 'deleteEntry')
      .mockRejectedValueOnce(new Error('simulated delete failure'))
      .mockRejectedValueOnce(new Error('simulated delete failure'))
      .mockImplementation((id: string) => realDelete(id))
    const regenSpy = vi.spyOn(summaryModule, 'scheduleSummaryRegeneration')

    await mountView()
    await waitForRows(1)

    // First attempt fails: the list stays visible, confirm closes, row intact.
    await rowByTitle('doomed once').find('.entry-delete').trigger('click')
    await rowByTitle('doomed once').find('.confirm-yes').trigger('click')
    await vi.waitFor(() => {
      expect(wrapper.find('.delete-error').exists()).toBe(true)
    })
    expect(wrapper.findAll('.entry-row')).toHaveLength(1)
    expect(wrapper.find('.delete-confirm').exists()).toBe(false)
    expect(await db.entries.get('e-gone')).toBeDefined()
    expect(wrapper.find('.delete-error-text').text()).toContain('We could not delete')

    // Dismiss clears the ephemeral error without touching the row.
    await wrapper.find('.delete-error-dismiss').trigger('click')
    expect(wrapper.find('.delete-error').exists()).toBe(false)
    expect(wrapper.findAll('.entry-row')).toHaveLength(1)

    // A second failure reappears the error; the Retry button re-opens the confirm.
    await rowByTitle('doomed once').find('.entry-delete').trigger('click')
    await rowByTitle('doomed once').find('.confirm-yes').trigger('click')
    await vi.waitFor(() => {
      expect(wrapper.find('.delete-error').exists()).toBe(true)
    })
    await wrapper.find('.delete-error-retry').trigger('click')
    expect(wrapper.find('.delete-confirm').exists()).toBe(true)

    // Third attempt goes through the real delete: row re-renders away,
    // follow-up cascades, and the W11 seam fires exactly once (only success).
    await wrapper.find('.confirm-yes').trigger('click')
    await vi.waitFor(() => {
      expect(wrapper.findAll('.entry-row')).toHaveLength(0)
    })
    expect(await db.entries.get('e-gone')).toBeUndefined()
    expect(await db.followupResponses.where('entryId').equals('e-gone').count()).toBe(0)
    expect(deleteSpy).toHaveBeenCalledTimes(3)
    expect(regenSpy).toHaveBeenCalledTimes(1)
    expect(regenSpy).toHaveBeenCalledWith('entry-deleted')
    expect(wrapper.find('.empty-note').text()).toContain('Nothing here yet')
  })

  it('"Keep" cancels the confirm without deleting, and opening confirm on one row never removes another', async () => {
    await seedEntry({
      id: 'e-safe',
      createdAt: iso(2026, 7, 17, 8),
      content: 'safe entry',
      moodEmoji: '🙂',
    })
    await seedEntry({
      id: 'e-safe-2',
      createdAt: iso(2026, 7, 10, 8),
      content: 'another entry',
      moodEmoji: '🙂',
    })

    await mountView()
    await waitForRows(2)

    const row = rowByTitle('safe entry')
    await row.find('.entry-delete').trigger('click')
    expect(row.find('.delete-confirm').exists()).toBe(true)

    await row.find('.confirm-no').trigger('click')
    expect(wrapper.find('.delete-confirm').exists()).toBe(false)
    expect(await db.entries.get('e-safe')).toBeDefined()

    // Opening the confirm on a second row moves it there — one at a time.
    const secondRow = rowByTitle('another entry')
    await secondRow.find('.entry-delete').trigger('click')
    await secondRow.find('.confirm-no').trigger('click')
    expect(wrapper.find('.delete-confirm').exists()).toBe(false)
    expect(await db.entries.get('e-safe-2')).toBeDefined()
  })
})