import { beforeEach, describe, expect, it } from 'vitest'
import { createMemoryHistory, createRouter } from 'vue-router'
import { db } from '../../lib/db/schema'
import { completeOnboarding } from '../../lib/db/settings'
import { ensureOnboarded, routes } from '../index'

/** Memory-history router with the W4 guard wired up, like the app shell does. */
function makeGuardedRouter() {
  const router = createRouter({ history: createMemoryHistory(), routes })
  router.beforeEach(ensureOnboarded)
  return router
}

beforeEach(async () => {
  await Promise.all(db.tables.map((table) => table.clear()))
})

describe('onboarding route guard (W4)', () => {
  it('redirects to /onboarding when onboarding is not completed', async () => {
    const router = makeGuardedRouter()

    await router.push('/')
    await router.isReady()

    expect(router.currentRoute.value.name).toBe('onboarding')
  })

  it('lets / resolve after onboarding is completed', async () => {
    await completeOnboarding()
    const router = makeGuardedRouter()

    await router.push('/')
    await router.isReady()

    expect(router.currentRoute.value.name).toBe('dashboard')
  })

  it('allows /onboarding itself (no redirect loop)', async () => {
    const router = makeGuardedRouter()

    await router.push('/onboarding')
    await router.isReady()

    expect(router.currentRoute.value.name).toBe('onboarding')
  })
})
