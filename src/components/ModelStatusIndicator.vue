<script setup lang="ts">
/**
 * ModelStatusIndicator — a small, always-visible "light" in the app shell
 * showing whether the on-device AI is available.
 *
 *   ● green  "AI ready"        model downloaded + working
 *   ● amber  "setting up AI…"  downloading / loading
 *   ● gray   "AI off"          model not loaded (not yet requested)
 *   ● red    "AI unavailable"  load or inference failed
 *
 * Purely informational / non-interactive for M1 (the ModelGate sheet is the
 * interactive surface that loads the model when a feature needs it). Shown
 * on the main navigation screens (where the tabbar renders); hidden on the
 * focused full-screen flows (onboarding, new entry) where the finish bar /
 * gate would collide and where the gate already surfaces model state inline.
 */
import { computed } from 'vue'
import { useModel } from '../composables/useModel'

const { status } = useModel()

interface Indicator {
  kind: 'on' | 'loading' | 'off' | 'error'
  label: string
}

const indicator = computed<Indicator>(() => {
  switch (status.value.state) {
    case 'ready':
      return { kind: 'on', label: 'AI ready' }
    case 'loading':
      return { kind: 'loading', label: 'setting up AI…' }
    case 'error':
      return { kind: 'error', label: 'AI unavailable' }
    default:
      return { kind: 'off', label: 'AI off' }
  }
})

const description = computed(() => {
  const base = 'On-device AI'
  switch (indicator.value.kind) {
    case 'on':
      return `${base} ready and working`
    case 'loading':
      return `${base} is being set up`
    case 'off':
      return `${base} is off — it loads only when a feature needs it`
    case 'error':
      return `${base} is unavailable right now`
  }
})
</script>

<template>
  <div
    class="model-status"
    :class="`model-status--${indicator.kind}`"
    role="status"
    :aria-label="description"
    :title="description"
    data-testid="model-status"
  >
    <span class="model-status__dot" aria-hidden="true"></span>
    <span class="model-status__label">{{ indicator.label }}</span>
  </div>
</template>

<style scoped>
.model-status {
  position: fixed;
  left: 16px;
  bottom: 92px; /* just above the tabbar, mirrored to the FAB's right-side spot */
  display: inline-flex;
  align-items: center;
  gap: 7px;
  padding: 6px 11px;
  background: rgba(21, 19, 15, 0.9);
  backdrop-filter: blur(8px);
  border: 1px solid var(--border);
  border-radius: 20px;
  font-family: 'JetBrains Mono', monospace;
  font-size: 9.5px;
  letter-spacing: 0.04em;
  color: var(--text-muted);
  z-index: 9;
  user-select: none;
  pointer-events: none; /* purely informational — never blocks taps underneath */
}

.model-status__dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
}

/* ready — the green light */
.model-status--on .model-status__dot {
  background: #6ecb8f;
  box-shadow: 0 0 6px rgba(110, 203, 143, 0.6);
}
.model-status--on .model-status__label {
  color: #a8dcb6;
}

/* loading — amber, gently pulsing */
.model-status--loading .model-status__dot {
  background: var(--accent);
  animation: status-pulse 1.2s ease-in-out infinite;
}
.model-status--loading .model-status__label {
  color: var(--accent);
}

/* off — the light is out */
.model-status--off .model-status__dot {
  background: #55503f;
}

/* error — signal the failure */
.model-status--error .model-status__dot {
  background: var(--crisis);
}
.model-status--error .model-status__label {
  color: #d68e92;
}

@keyframes status-pulse {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.35;
  }
}

@media (prefers-reduced-motion: reduce) {
  .model-status--loading .model-status__dot {
    animation: none;
  }
}
</style>
