/**
 * useModel — W8. Reactive view over the shared WllamaClient state machine.
 *
 * Wraps the module-level `modelClient` singleton: exposes its status as a
 * reactive ref (kept in sync via subscription, auto-unsubscribed on scope
 * end), an `ensureReady()` helper for model-requiring actions, and a
 * per-session "not now" dismissal for the ModelGate overlay.
 *
 * The core journaling/entry/dashboard/history flows never touch this — the
 * model is optional scaffolding. Only W9/W10 mount a ModelGate and call
 * ensureReady() when the user actually triggers a model-requiring action.
 */
import { computed, onScopeDispose, ref, type ComputedRef, type Ref } from 'vue'
import { modelClient, type ModelStatus } from '../lib/model/wllama-client'

export interface UseModelReturn {
  /** Reactive status of the shared client. */
  status: Readonly<Ref<ModelStatus>>
  isReady: ComputedRef<boolean>
  /** True once the user chose "Not now — just write for now" this session. */
  isDismissed: Ref<boolean>
  /** Kick off the lazy load (idempotent) and resolve true when the model is ready. */
  ensureReady: () => Promise<boolean>
  /** Hide the ModelGate sheet for this session. */
  dismiss: () => void
}

/** Discriminant check isolated in a fresh parameter so TS never narrows it out of the union. */
function isReadyState(status: ModelStatus): boolean {
  return status.state === 'ready'
}

export function useModel(): UseModelReturn {
  const status = ref<ModelStatus>(modelClient.getModelStatus())
  const isDismissed = ref(false)

  const unsubscribe = modelClient.subscribe((next) => {
    status.value = next
  })
  onScopeDispose(unsubscribe)

  const isReady = computed(() => isReadyState(status.value))

  async function ensureReady(): Promise<boolean> {
    if (isReadyState(status.value)) return true
    try {
      await modelClient.getModel()
    } catch {
      return false
    }
    // Read through a fresh narrow, not status.value.state directly: TS keeps
    // the discriminated narrowing from the early return across the awaited
    // load and flags the widened union comparison as unreachable otherwise.
    return isReadyState(status.value)
  }

  function dismiss(): void {
    isDismissed.value = true
  }

  return { status, isReady, isDismissed, ensureReady, dismiss }
}
