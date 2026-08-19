import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createMemoryHistory, createRouter, type Router } from 'vue-router'
import EntryDetailView from '../EntryDetailView.vue'
import { routes } from '../../../router'
import { encryptText, getOrCreateDeviceKey } from '../../../lib/db/crypto'
import { db } from '../../../lib/db/schema'

let router: Router
let wrapper: VueWrapper

async function mountAt(entryId: string) {
  router = createRouter({ history: createMemoryHistory(), routes })
  router.push(`/history/${entryId}`)
  await router.isReady()
  wrapper = mount(EntryDetailView, { global: { plugins: [router] } })
  await flushPromises()
  // IndexedDB + Web Crypto settle across several event-loop turns; poll
  // until the view has rendered one of its settled states (see W6b tests).
  await vi.waitFor(() => {
    const settled =
      wrapper.find('.load-error').exists() ||
      wrapper.find('.empty-note').exists() ||
      wrapper.find('.entry-text').exists()
    expect(settled).toBe(true)
  })
}

async function seedEntry(seed: {
  id: string
  createdAt: string
  content: string
  moodEmoji?: string
  hasFollowup?: boolean
}): Promise<void> {
  const key = await getOrCreateDeviceKey()
  await db.entries.add({
    id: seed.id,
    createdAt: seed.createdAt,
    contentEncrypted: await encryptText(key, seed.content),
    moodEmoji: seed.moodEmoji ?? '',
    hasFollowup: seed.hasFollowup ?? false,
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

const iso = (year: number, month: number, day: number, hour = 12, minute = 0) =>
  new Date(year, month, day, hour, minute).toISOString()

beforeEach(async () => {
  await Promise.all(db.tables.map((table) => table.clear()))
})

afterEach(() => {
  wrapper?.unmount()
})

describe('EntryDetailView (W7) — decrypted detail surface', () => {
  it('shows the back link, local date header, mood, and the full decrypted entry in Fraunces', async () => {
    await seedEntry({
      id: 'e-1',
      createdAt: iso(2026, 7, 17, 8, 42),
      content: 'The depgraph thing finally clicked.\n\nThen I went for a walk.',
      moodEmoji: '🙂',
    })

    await mountAt('e-1')

    expect(wrapper.find('.back-link').attributes('href')).toBe('/history')
    expect(wrapper.find('.app-date').text()).toContain('17 August 2026')
    expect(wrapper.find('.app-date').text()).toContain('08:42')
    expect(wrapper.find('.detail-mood').text()).toBe('🙂')
    expect(wrapper.find('.entry-text').text()).toBe(
      'The depgraph thing finally clicked.\n\nThen I went for a walk.',
    )

    // No follow-up aside when there are none (W10 seam renders nothing).
    expect(wrapper.find('.followup-aside').exists()).toBe(false)
  })

  it('omits the mood chip when the entry was saved without one', async () => {
    await seedEntry({ id: 'e-1', createdAt: iso(2026, 7, 17, 8), content: 'no mood', moodEmoji: '' })

    await mountAt('e-1')

    expect(wrapper.find('.detail-mood').exists()).toBe(false)
  })

  it('re-loads when the route id changes (id → id navigation) instead of showing stale content', async () => {
    await seedEntry({ id: 'e-1', createdAt: iso(2026, 7, 17, 8), content: 'first entry', moodEmoji: '🙂' })
    await seedEntry({ id: 'e-2', createdAt: iso(2026, 7, 18, 8), content: 'second entry', moodEmoji: '😌' })

    await mountAt('e-1')
    expect(wrapper.find('.entry-text').text()).toBe('first entry')

    // Same route record, new param — the component is reused, so the watch
    // must reload rather than keep e-1's decrypted content on screen.
    router.push('/history/e-2')
    await vi.waitFor(() => {
      expect(wrapper.find('.entry-text').text()).toBe('second entry')
    })
    expect(wrapper.find('.detail-mood').text()).toBe('😌')
  })

  it('shows a friendly note for an unknown id and never renders a blank page', async () => {
    await mountAt('missing')

    expect(wrapper.find('.empty-note').text()).toContain('This entry no longer exists')
    expect(wrapper.find('.entry-text').exists()).toBe(false)
  })
})

describe('EntryDetailView (W7) — follow-ups appended inline (decision T2)', () => {
  it('renders each follow-up as an aside with the re: question and the response', async () => {
    await seedEntry({
      id: 'e-1',
      createdAt: iso(2026, 7, 17, 8),
      content: 'about a hike',
      moodEmoji: '😌',
      hasFollowup: true,
    })
    await seedFollowup({
      id: 'f-1',
      entryId: 'e-1',
      question: 'You mentioned the ridge trail again — has anything shifted?',
      response: 'It felt shorter this time.',
    })
    await seedFollowup({
      id: 'f-2',
      entryId: 'e-1',
      question: 'What made today different?',
      response: 'I had coffee first.',
    })

    await mountAt('e-1')

    const asides = wrapper.findAll('.followup-aside')
    expect(asides).toHaveLength(2)
    const firstLabel = asides[0].find('.followup-re').text()
    // The literal template text (no ::before content rule may add a second
    // "re:" — jsdom ignores pseudo-elements, so this count is the guard).
    expect(firstLabel).toBe('re: You mentioned the ridge trail again — has anything shifted?')
    expect(firstLabel.match(/re:/g)).toHaveLength(1)
    expect(asides[0].find('.followup-response').text()).toBe('It felt shorter this time.')
    expect(asides[1].find('.followup-re').text()).toBe('re: What made today different?')
    expect(asides[1].find('.followup-response').text()).toBe('I had coffee first.')
  })

  it('renders nothing follow-up related when a row has followups but no rows exist yet', async () => {
    // hasFollowup flag true (a W10 row would normally exist) but the
    // followups table is empty — the seam must degrade gracefully.
    await seedEntry({
      id: 'e-1',
      createdAt: iso(2026, 7, 17, 8),
      content: 'entry with stale flag',
      moodEmoji: '🙂',
      hasFollowup: true,
    })

    await mountAt('e-1')

    expect(wrapper.find('.entry-text').text()).toBe('entry with stale flag')
    expect(wrapper.find('.followup-aside').exists()).toBe(false)
  })
})