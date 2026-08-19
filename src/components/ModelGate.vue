<script setup lang="ts">
/**
 * ModelGate — W8 first-run "downloading your private AI" sheet.
 *
 * A wrapper that slots around model-requiring UI (W9 stuck prompts, W10
 * follow-ups). The sheet appears only when a model action is first
 * attempted: the slotted code calls `useModel().ensureReady()`, which
 * flips the shared client into `loading`, and this component renders the
 * warm overlay with a byte progress bar. Writing/dashboard/history flows
 * never mount a gate, so the journal always works without the model —
 * the model is optional scaffolding by design (docs/architecture.md).
 *
 * States rendered here:
 *   - unloaded: nothing shown — load hasn't been triggered yet.
 *   - loading:  dark sheet + progress bar + offline reassurance.
 *   - error:    clear message + Retry + "Not now — just write for now".
 *   - ready:    nothing shown (gate disappears).
 *
 * "Not now" dismissal is per-session (this component instance). If a
 * download is already underway, choosing "not now" just hides the sheet;
 * the load keeps running in the background and the gate stays gone.
 */
import { computed } from 'vue'
import { useModel } from '../composables/useModel'

defineOptions({ name: 'ModelGate' })

const emit = defineEmits<{
  /** Fired when the user picks "Not now — just write for now". W10 listens to close its flow. */
  dismissed: []
}>()

const props = withDefaults(
  defineProps<{
    /** Overlay title, e.g. "Setting up your private AI". */
    title?: string
    /** Reassurance line shown while the model downloads. */
    note?: string
    /**
     * When false, the sheet never renders even while the model loads — the
     * slot content still renders. Lets a page mount one gate per consumer
     * (W9 stuck card + W10 follow-ups) without their sheets colliding; the
     * inactive gate keeps showing its slot. Defaults true (W10 behavior).
     */
    active?: boolean
  }>(),
  {
    title: 'Setting up your private AI',
    note: 'Runs 100% on your device. One-time download — after this it works fully offline, even in airplane mode.',
    active: true,
  },
)

const { status, isDismissed, dismiss, ensureReady } = useModel()

const showSheet = computed(
  () =>
    props.active &&
    !isDismissed.value &&
    (status.value.state === 'loading' || status.value.state === 'error'),
)

const progressPercent = computed(() => {
  if (status.value.state !== 'loading') return 0
  const { loadedBytes, totalBytes } = status.value
  if (totalBytes <= 0) return 0
  return Math.min(100, Math.round((loadedBytes / totalBytes) * 100))
})

function formatBytes(bytes: number): string {
  if (bytes <= 0) return '0 MB'
  const megabyte = 1024 * 1024
  const mb = bytes / megabyte
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`
  return `${Math.round(mb)} MB`
}

async function handleRetry(): Promise<void> {
  // The client dropped its shared promise on error, so this reloads fresh.
  await ensureReady()
}

/** Hide the sheet for this session and tell the owner (e.g. W10) it happened. */
function handleDismiss(): void {
  dismiss()
  emit('dismissed')
}
</script>

<template>
  <div class="model-gate">
    <slot />

    <Teleport to="body">
      <div v-if="showSheet" class="model-sheet" role="dialog" aria-modal="true" aria-label="Model setup">
        <div class="sheet-card">
          <h2 class="sheet-path">{{ props.title }}</h2>
          <p class="sheet-note">{{ props.note }}</p>

          <template v-if="status.state === 'loading'">
            <div
              class="progress"
              role="progressbar"
              aria-valuemin="0"
              aria-valuemax="100"
              :aria-valuenow="progressPercent"
            >
              <div class="progress-track">
                <div class="progress-fill" :style="{ width: `${progressPercent}%` }" />
              </div>
              <span class="progress-meta">
                {{ formatBytes(status.loadedBytes) }} of {{ formatBytes(status.totalBytes) }}
              </span>
            </div>
          </template>

          <p v-else-if="status.state === 'error'" class="sheet-error">
            Something went wrong while downloading your private AI.
          </p>

          <div class="sheet-actions">
            <button v-if="status.state === 'error'" type="button" class="btn-primary" @click="handleRetry">
              Retry
            </button>
            <button
              v-if="status.state === 'loading' || status.state === 'error'"
              type="button"
              class="btn-ghost"
              @click="handleDismiss"
            >
              Not now — just write for now
            </button>
          </div>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.model-gate {
  display: contents;
}

/* Dimmed scrim behind the sheet, aligned to the warm dark design system. */
.model-sheet {
  position: fixed;
  inset: 0;
  z-index: 60;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: var(--space-4);
  background: rgba(10, 9, 7, 0.62);
  backdrop-filter: blur(2px);
}

.sheet-card {
  width: min(420px, 100%);
  background: var(--surface-raised);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  padding: var(--space-4);
  box-shadow: 0 18px 48px rgba(0, 0, 0, 0.45);
}

.sheet-path {
  font-family: 'Fraunces', serif;
  font-weight: 500;
  font-size: 20px;
  letter-spacing: -0.01em;
  margin-bottom: var(--space-2);
}

.sheet-note {
  color: var(--text-muted);
  font-size: 13px;
  line-height: 1.55;
  margin-bottom: var(--space-3);
}

.sheet-error {
  color: var(--crisis);
  font-size: 13px;
  margin-bottom: var(--space-3);
}

.progress {
  margin-bottom: var(--space-3);
}

.progress-track {
  height: 8px;
  border-radius: 999px;
  background: var(--border);
  overflow: hidden;
}

.progress-fill {
  height: 100%;
  border-radius: inherit;
  background: var(--accent);
  transition: width 0.2s ease;
}

.progress-meta {
  display: block;
  margin-top: var(--space-2);
  font-family: 'JetBrains Mono', monospace;
  font-size: 11px;
  color: var(--accent);
}

.sheet-actions {
  display: flex;
  gap: var(--space-2);
  flex-wrap: wrap;
}

.btn-primary,
.btn-ghost {
  font-family: inherit;
  font-size: 13px;
  padding: 8px 14px;
  border-radius: var(--radius-md);
  cursor: pointer;
}

.btn-primary {
  background: var(--accent);
  color: #1a1408;
  border: 1px solid transparent;
  font-weight: 600;
}

.btn-ghost {
  background: transparent;
  color: var(--text-muted);
  border: 1px solid var(--border);
}

.btn-ghost:hover {
  color: var(--text);
  border-color: var(--text-muted);
}
</style>
