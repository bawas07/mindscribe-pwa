/**
 * ModelStatusIndicator — render tests for each status state.
 *
 * The model client is mocked at the module boundary (no wllama import), so
 * the indicator is driven purely through client state transitions:
 * unloaded → off, loading → amber "setting up AI…", ready → green "AI ready",
 * error → red "AI unavailable". Same mock shape as ModelGate.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'

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

// Re-import through the composable the component actually uses.
import ModelStatusIndicator from '../ModelStatusIndicator.vue'
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const clientMock = vi.mocked((await import('../../lib/model/wllama-client')).modelClient) as any

function mountIndicator() {
  return mount(ModelStatusIndicator)
}

function statusElement(wrapper: ReturnType<typeof mountIndicator>) {
  return wrapper.get('[data-testid="model-status"]')
}

describe('ModelStatusIndicator — the AI light', () => {
  beforeEach(() => {
    clientMock.__emit({ state: 'unloaded' })
  })

  it('shows a dim "off" light while the model has never been requested', () => {
    const wrapper = mountIndicator()
    const el = statusElement(wrapper)
    expect(el.classes()).toContain('model-status--off')
    expect(el.find('.model-status__label').text()).toBe('AI off')
    expect(el.attributes('aria-label')).toContain('off')
  })

  it('turns GREEN with "AI ready" when the model is loaded and working', async () => {
    const wrapper = mountIndicator()
    clientMock.__emit({ state: 'ready' })
    await wrapper.vm.$nextTick()

    const el = statusElement(wrapper)
    expect(el.classes()).toContain('model-status--on')
    expect(el.find('.model-status__label').text()).toBe('AI ready')
    expect(el.find('.model-status__dot').classes().length).toBeGreaterThan(0)
    expect(el.attributes('aria-label')).toContain('ready and working')
  })

  it('shows an amber "setting up AI…" light while downloading/loading', async () => {
    const wrapper = mountIndicator()
    clientMock.__emit({ state: 'loading', progress: { loaded: 100, total: 1000 } })
    await wrapper.vm.$nextTick()

    const el = statusElement(wrapper)
    expect(el.classes()).toContain('model-status--loading')
    expect(el.find('.model-status__label').text()).toBe('setting up AI…')
  })

  it('shows a red "AI unavailable" light when the model load fails', async () => {
    const wrapper = mountIndicator()
    clientMock.__emit({ state: 'error' })
    await wrapper.vm.$nextTick()

    const el = statusElement(wrapper)
    expect(el.classes()).toContain('model-status--error')
    expect(el.find('.model-status__label').text()).toBe('AI unavailable')
    expect(el.attributes('aria-label')).toContain('unavailable')
  })

  it('updates reactively when the status transitions off → loading → ready', async () => {
    const wrapper = mountIndicator()
    expect(statusElement(wrapper).classes()).toContain('model-status--off')

    clientMock.__emit({ state: 'loading' })
    await wrapper.vm.$nextTick()
    expect(statusElement(wrapper).classes()).toContain('model-status--loading')

    clientMock.__emit({ state: 'ready' })
    await wrapper.vm.$nextTick()
    expect(statusElement(wrapper).classes()).toContain('model-status--on')
  })
})
