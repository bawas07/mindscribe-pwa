/**
 * W8 — ModelGate overlay render tests.
 *
 * The model client is mocked at the module boundary (no wllama import), so
 * these tests drive the gate purely through client state transitions —
 * unloaded (nothing), loading (progress sheet), error (Retry + "Not now"),
 * plus per-session dismissal. The sheet teleports to <body>; assertions
 * query document.body.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { nextTick } from 'vue'

vi.mock('../../lib/model/wllama-client', () => {
  const listeners = new Set<(s: unknown) => void>()
  let status: unknown = { state: 'unloaded' }
  const getModel = vi.fn(async () => {})
  return {
    modelClient: {
      getModelStatus: () => status,
      subscribe: (fn: (s: unknown) => void) => {
        listeners.add(fn)
        return () => listeners.delete(fn)
      },
      getModel,
      __emit: (next: unknown) => {
        status = next
        listeners.forEach((fn) => fn(next))
      },
    },
  }
})

// Re-import through the composable path the component actually uses.
import ModelGate from '../ModelGate.vue'
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const clientMock = vi.mocked((await import('../../lib/model/wllama-client')).modelClient) as any

function querySheet() {
  return document.body.querySelector('.model-sheet')
}

describe('ModelGate', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
    clientMock.__emit({ state: 'unloaded' })
    clientMock.getModel.mockClear()
  })

  it('renders nothing while the model is unloaded', async () => {
    const wrapper = mount(ModelGate, { slots: { default: '<div class="core-ui" />' } })
    await nextTick()
    expect(wrapper.find('.core-ui').exists()).toBe(true)
    expect(querySheet()).toBeNull()
    wrapper.unmount()
  })

  it('shows the download sheet with a byte progress bar while loading', async () => {
    const wrapper = mount(ModelGate, { slots: { default: '<p>wrapped</p>' } })
    clientMock.__emit({ state: 'loading', loadedBytes: 100 * 1024 * 1024, totalBytes: 688 * 1024 * 1024 })
    await nextTick()

    const sheet = querySheet() as HTMLElement
    expect(sheet).not.toBeNull()
    expect(sheet.querySelector('.sheet-path')?.textContent).toBe('Setting up your private AI')
    expect(sheet.querySelector('.progress')).not.toBeNull()
    expect(sheet.querySelector('.progress-meta')?.textContent).toContain('MB')
    expect(sheet.textContent).toContain('fully offline')

    wrapper.unmount()
  })

  it('shows Retry + "Not now" in the error state, and Retry triggers a reload', async () => {
    const wrapper = mount(ModelGate)
    clientMock.__emit({ state: 'error', message: 'boom' })
    await nextTick()

    const sheet = querySheet() as HTMLElement
    expect(sheet).not.toBeNull()
    const buttons = Array.from(sheet.querySelectorAll('button')).map((b) => b.textContent ?? '')
    expect(buttons.some((t) => t.includes('Retry'))).toBe(true)
    expect(buttons.some((t) => t.includes('Not now'))).toBe(true)

    const retry = Array.from(sheet.querySelectorAll('button')).find((b) => b.textContent?.includes('Retry'))
    retry?.dispatchEvent(new Event('click'))
    await flushPromises()
    expect(clientMock.getModel).toHaveBeenCalledTimes(1)

    wrapper.unmount()
  })

  it('"Not now — just write for now" dismisses the sheet for the session', async () => {
    const wrapper = mount(ModelGate)
    clientMock.__emit({ state: 'error', message: 'boom' })
    await nextTick()
    expect(querySheet()).not.toBeNull()

    const dismiss = Array.from(document.body.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('Not now'),
    )
    dismiss?.dispatchEvent(new Event('click'))
    await nextTick()
    expect(querySheet()).toBeNull()

    // Still stays hidden even if the state flips back to loading.
    clientMock.__emit({ state: 'loading', loadedBytes: 1, totalBytes: 10 })
    await nextTick()
    expect(querySheet()).toBeNull()

    wrapper.unmount()
  })

  it('supports a custom title', async () => {
    const wrapper = mount(ModelGate, { props: { title: 'Loading your model' } })
    clientMock.__emit({ state: 'loading', loadedBytes: 0, totalBytes: 10 })
    await nextTick()
    expect(querySheet()?.querySelector('.sheet-path')?.textContent).toBe('Loading your model')
    wrapper.unmount()
  })
})
