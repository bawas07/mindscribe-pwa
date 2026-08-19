import { createRouter, createWebHistory, type RouteLocationNormalized } from 'vue-router'
import type { RouteRecordRaw } from 'vue-router'
import DashboardView from '../views/DashboardView.vue'
import NewEntryView from '../views/entry/NewEntryView.vue'
import HistoryView from '../views/history/HistoryView.vue'
import EntryDetailView from '../views/history/EntryDetailView.vue'
import SettingsView from '../views/settings/SettingsView.vue'
import OnboardingView from '../views/OnboardingView.vue'
import { getOrCreateSettings } from '../lib/db/settings'

// Route meta flags used by the app shell in App.vue.
declare module 'vue-router' {
  interface RouteMeta {
    /** Full-screen routes (no bottom tab bar): onboarding, new entry. */
    hideTabbar?: boolean
  }
}

export const routes: RouteRecordRaw[] = [
  { path: '/', name: 'dashboard', component: DashboardView },
  { path: '/entry/new', name: 'new-entry', component: NewEntryView, meta: { hideTabbar: true } },
  { path: '/history', name: 'history', component: HistoryView },
  { path: '/history/:id', name: 'entry-detail', component: EntryDetailView },
  { path: '/settings', name: 'settings', component: SettingsView },
  { path: '/onboarding', name: 'onboarding', component: OnboardingView, meta: { hideTabbar: true } },
]

export const router = createRouter({
  history: createWebHistory(),
  routes,
})

/**
 * W4 onboarding gate: nothing renders until onboarding is completed
 * (first open only). Ensures the settings row exists, then redirects to
 * /onboarding while the flag is still false. /onboarding itself is exempt
 * so the guard can never loop. A named export so tests can exercise it
 * against a memory-history router.
 */
export async function ensureOnboarded(to: RouteLocationNormalized): Promise<true | string> {
  if (to.name === 'onboarding') return true

  const settings = await getOrCreateSettings()
  return settings.onboardingCompleted ? true : '/onboarding'
}

router.beforeEach(ensureOnboarded)

export default router
