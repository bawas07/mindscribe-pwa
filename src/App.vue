<script setup lang="ts">
import { useRoute } from 'vue-router'
import ModelStatusIndicator from './components/ModelStatusIndicator.vue'

const route = useRoute()

const tabs = [
  { routeName: 'dashboard', label: 'Dashboard', icon: '◈', to: '/' },
  { routeName: 'history', label: 'History', icon: '☰', to: '/history' },
  { routeName: 'settings', label: 'Settings', icon: '⚙', to: '/settings' },
]
</script>

<template>
  <div class="app-shell">
    <main class="screen">
      <router-view />
    </main>
    <ModelStatusIndicator v-if="!route.meta.hideTabbar" />
    <nav v-if="!route.meta.hideTabbar" class="tabbar" aria-label="Primary">
      <router-link
        v-for="tab in tabs"
        :key="tab.routeName"
        :to="tab.to"
        class="tab"
        :class="{ active: route.name === tab.routeName }"
      >
        <span class="tab-icon" aria-hidden="true">{{ tab.icon }}</span>
        {{ tab.label }}
      </router-link>
    </nav>
  </div>
</template>

<style scoped>
.app-shell {
  min-height: 100dvh;
}

.screen {
  padding: var(--space-4) var(--space-4) 100px;
}

/* Bottom nav — mirrors the wireframe tabbar (docs/example-journal-first.html) */
.tabbar {
  position: fixed;
  bottom: 0;
  left: 0;
  right: 0;
  height: 76px;
  background: rgba(21, 19, 15, 0.92);
  backdrop-filter: blur(10px);
  border-top: 1px solid var(--border);
  display: flex;
  align-items: center;
  justify-content: space-around;
  padding-bottom: 10px;
  z-index: 10;
}

.tab {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  font-family: 'JetBrains Mono', monospace;
  font-size: 10px;
  color: #55503f;
  text-decoration: none;
}

.tab.active {
  color: var(--accent);
}

.tab-icon {
  font-size: 18px;
}
</style>
