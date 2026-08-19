import { beforeEach, describe, expect, it } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createMemoryHistory, createRouter } from 'vue-router'
import App from '../App.vue'
import { db } from '../lib/db/schema'
import { routes } from '../router'

beforeEach(async () => {
  await Promise.all(db.tables.map((table) => table.clear()))
})

describe('app shell', () => {
  it('mounts App with the router and renders the W5 dashboard inside the tabbar shell', async () => {
    const router = createRouter({ history: createMemoryHistory(), routes })
    router.push('/')
    await router.isReady()

    const wrapper = mount(App, { global: { plugins: [router] } })

    expect(wrapper.find('.app-title').text()).toBe('mind·scribe')
    expect(wrapper.find('.fab').exists()).toBe(true)
    expect(wrapper.find('.tabbar').exists()).toBe(true)

    // Let the dashboard's async loads settle: with a cleared db the
    // empty state (plan W5 AC) appears under the calendar.
    await flushPromises()
    expect(wrapper.find('.empty-note').text()).toContain("Nothing here yet")

    wrapper.unmount()
  })
})
