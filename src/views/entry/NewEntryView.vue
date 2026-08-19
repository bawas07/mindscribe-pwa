<script setup lang="ts">
/**
 * W6b/W9 — journal-first entry editor (wireframe frames 02/03/04/05).
 *
 * Flow per docs/flow.md: blank page → free write → Done → mood → save.
 * The stuck path (W9) is two-tier: tier 1 ("From your recent entries") is
 * MODEL-PHRASED — the gate loads the on-device model, which turns the
 * theme into one open question, with the template pool as the standing
 * fallback; tier 2 is the generic rotating pool (no history, model-free).
 * The opt-in follow-up (W10) ships here too — opt-in, never blocks writing.
 */
import { computed, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { MONTH_ABBREVIATIONS } from '../../lib/calendar'
import {
  countEntries,
  createEntry,
  deriveTitle,
  getEntry,
  listRecentEntries,
  type DecryptedEntry,
} from '../../lib/entries'
import { checkCrisisSignal } from '../../lib/safety/crisis-check'
import { buildCrisisPanel, type CrisisPanel } from '../../lib/safety/panel'
import {
  advanceStuckPromptFlow,
  buildThemedStuckPrompts,
  currentStuckPromptFlow,
  startStuckPromptFlow,
  type StuckPromptFlow,
} from '../../lib/stuck-themes'
import { getThemes } from '../../lib/model/summary'
import { generateThemedQuestion, selectMentionEntries } from '../../lib/model/themed-question'
import type { Theme } from '../../lib/model/themes'
import { useModel } from '../../composables/useModel'
import ModelGate from '../../components/ModelGate.vue'
import {
  canAskFollowup,
  createFollowupResponse,
  FOLLOWUP_MAX_QUESTIONS,
  isFollowupWorthy,
  type FollowupResponseInput,
} from '../../lib/followups'
import {
  generateFollowUpQuestion,
  FOLLOWUP_MAX_REFERENCED_ENTRIES,
  type FollowupContextEntry,
} from '../../lib/model/followups'

const router = useRouter()
const { ensureReady, status } = useModel()

/** Moods offered in the finish bar, in the wireframe's order (frame 05). */
const MOODS = ['😔', '😐', '🙂', '😌', '😤'] as const

type EntryStage = 'writing' | 'done' | 'saving'

/**
 * W10 follow-up substates (D5 — opt-in, user-initiated; the model never
 * interjects). `offer` = opt-in card, `loading` = gate/download or question
 * generation, `question` = Q1/Q2 card shown.
 */
type FollowupStage = 'off' | 'offer' | 'loading' | 'question' | 'failed'

/** One asked follow-up: question + reference ids + the delta-capture base. */
interface FollowupStep {
  question: string
  referencedEntryIds: string[]
  /** Entry-sheet content at the moment this question was shown — the delta base. */
  snapshot: string
  /** Captured response delta; null when skipped. Written once resolved. */
  response: string | null
  resolved: boolean
}

const content = ref('')
const stage = ref<EntryStage>('writing')
const selectedMood = ref('')
/** Gentle inline nudges ("Nothing to save yet.", "Saved.") — never blocking. */
const nudge = ref<string | null>(null)
const loadError = ref<string | null>(null)
/** Per-entry stuck-prompt flow; null while the card is closed (W9 two-tier). */
const stuckState = ref<StuckPromptFlow | null>(null)
/** Theme grounding the tier-1 card; the model phrases it when available. */
const stuckTheme = ref<Theme | null>(null)
/** The model's question for the current rotation position; '' = template stands. */
const stuckModelQuestion = ref('')
/** Light "thinking…" card state while the model phrases the question. */
const stuckThinking = ref(false)
/** True once the user picked "Not now" on the stuck gate — template from then on. */
const stuckGateDeclined = ref(false)
/** Latest refresh wins: a stale in-flight generation never paints a newer card. */
let stuckQuestionRequest = 0
/** How many recent entries to scan for mentions of the theme (grounding). */
const STUCK_THEME_SCAN_LIMIT = 20
/** Resource card rendered after a tripped save — always post-save, dismissible. */
const crisisPanel = ref<CrisisPanel | null>(null)
const editorRef = ref<HTMLTextAreaElement | null>(null)

/* ------------------------------------------------------------------ */
/* W10 follow-up flow state (D5/D6/T2 + the Surface principle).        */
/* ------------------------------------------------------------------ */

/** The entry text as it was at Done — the entry row saves THIS, not the response. */
const entryContentAtDone = ref('')
const followupStage = ref<FollowupStage>('off')
/** True once the user declines follow-ups (No thanks / close out / gate dismissed). */
const followupDeclined = ref(false)
/** True when the entry qualified for the opt-in at Done (worthiness + no crisis signal). */
const followupEligible = ref(false)
/** Every asked question, in ask order; max FOLLOWUP_MAX_QUESTIONS (T2). */
const askedFollowups = ref<FollowupStep[]>([])
/** Set when the ModelGate's "Not now" fires — used to abort an in-flight prepare. */
const gateDeclined = ref(false)
/** Swipe-peek (D6): revealed referenced entries + their drag state. */
const peekOpen = ref(false)
const peekEntries = ref<DecryptedEntry[]>([])
const peekDragStartY = ref<number | null>(null)

/** A question card is a pull-down gesture to reveal the peek (D6). */
const PEEK_DRAG_TRIGGER_PX = 60

/** Header date, e.g. "19 AUG" (wireframe frame 02's compact form). */
const headerDate = (() => {
  const now = new Date()
  const day = String(now.getDate()).padStart(2, '0')
  return `${day} ${MONTH_ABBREVIATIONS[now.getMonth()]}`
})()

/** Location-local HH:mm at mount; the wireframe shows a static clock. */
const liveTime = (() => {
  const now = new Date()
  const hours = String(now.getHours()).padStart(2, '0')
  const minutes = String(now.getMinutes()).padStart(2, '0')
  return `${hours}:${minutes}`
})()

const wordCount = computed(() => {
  const trimmed = content.value.trim()
  if (trimmed.length === 0) return 0
  return trimmed.split(/\s+/).length
})

/** Right-side meta label mirroring frame 02 ("thinking…" / n words) and 05 ("done"). */
const metaStatus = computed(() => {
  if (stage.value === 'saving') return 'saving…'
  if (stage.value !== 'writing') return 'done'
  if (wordCount.value > 0) return `${wordCount.value} ${wordCount.value === 1 ? 'word' : 'words'}`
  return 'thinking…'
})

/** The live (unresolved) question, i.e. the last pushed step. */
const currentStep = computed(() =>
  askedFollowups.value.length > 0 ? askedFollowups.value[askedFollowups.value.length - 1] : null,
)

/**
 * True once the live question has been engaged: skipped/resolved, or the
 * user has written something after it (the delta). Gates "One more?" so a
 * follow-up is only offered after the current one is answered or skipped.
 */
const currentStepAnswered = computed(() => {
  const step = currentStep.value
  if (!step) return false
  if (step.resolved) return true
  return content.value.length > step.snapshot.length
})

/**
 * Whether the opt-in / question block renders. Once a flow has started it
 * stays visible even if the user edits text below the worthiness floor — so
 * a mid-question edit can't yank the card away while they're thinking.
 */
const showFollowupBlock = computed(
  () =>
    stage.value === 'done' &&
    !followupDeclined.value &&
    (followupEligible.value || followupStage.value !== 'off'),
)

/** The peek affordance only makes sense when the question has real references. */
const showPeekAffordance = computed(
  () => followupStage.value === 'question' && (currentStep.value?.referencedEntryIds.length ?? 0) > 0,
)

const stuckPrompt = computed(() => {
  const flow = stuckState.value
  if (!flow) return ''
  if (stuckThinking.value && flow.tier === 'themed') return 'Thinking of a gentle question…'
  if (flow.tier === 'themed' && stuckModelQuestion.value) return stuckModelQuestion.value
  return currentStuckPromptFlow(flow)
})

/** The card's tier decides its eyebrow and accent (frames 03 vs 04). */
const stuckIsThemed = computed(() => stuckState.value?.tier === 'themed')
const stuckEyebrow = computed(() => (stuckIsThemed.value ? 'From your recent entries' : 'No pressure'))

function focusEditor() {
  editorRef.value?.focus()
}

onMounted(focusEditor)

/**
 * Done: empty content gets a gentle nudge; otherwise open the mood bar and —
 * only when the entry is follow-up-worthy and crisis-clean — the opt-in card
 * (D5: the model hasn't generated anything yet here).
 */
function handleDone() {
  if (content.value.trim().length === 0) {
    nudge.value = 'Nothing to save yet.'
    return
  }
  nudge.value = null
  stage.value = 'done'
  entryContentAtDone.value = content.value
  const worthy = isFollowupWorthy(content.value) && checkCrisisSignal(content.value).length === 0
  followupEligible.value = worthy
  followupStage.value = worthy ? 'offer' : 'off'
}

/** Drop all follow-up state — e.g. when the user re-enters writing mode. */
function resetFollowupFlow() {
  followupStage.value = 'off'
  followupDeclined.value = false
  gateDeclined.value = false
  followupEligible.value = false
  askedFollowups.value = []
  entryContentAtDone.value = ''
  peekOpen.value = false
  peekEntries.value = []
  peekDragStartY.value = null
}

function backToWriting() {
  stage.value = 'writing'
  nudge.value = null
  resetFollowupFlow()
  focusEditor()
}

/**
 * Save: capture any pending response deltas, persist the entry (content as
 * of Done — the response lives in the follow-up rows, not doubled into the
 * entry) encrypted through the repository, then persist each asked
 * follow-up into its own row. Follow-up persistence is deliberately
 * fire-and-log: the entry is already committed, so a failed follow-up write
 * can never take the entry down with it (flow/model failure never blocks a
 * save). The deterministic safety check runs post-commit and only then
 * renders the resource panel.
 */
async function handleSave() {
  if (!selectedMood.value) {
    nudge.value = 'Pick how today felt first.'
    return
  }
  stage.value = 'saving'
  nudge.value = null
  try {
    const followupDrafts = resolveFollowupDrafts()
    const entryId = await createEntry({ content: entryContentAtDone.value, moodEmoji: selectedMood.value })
    for (const draft of followupDrafts) {
      try {
        await createFollowupResponse({ ...draft, entryId })
      } catch (error) {
        // The entry is already saved — never abort the flow over a follow-up row.
        console.error('Failed to persist a follow-up:', error)
      }
    }
    const signals = checkCrisisSignal(content.value)
    if (signals.length > 0) {
      crisisPanel.value = buildCrisisPanel(signals)
      stage.value = 'done'
    } else {
      await router.push('/')
    }
  } catch (error) {
    // Never swallow: an encryption/write failure must be visible to the user.
    console.error('Failed to save entry:', error)
    loadError.value = 'We could not save your entry. Please try again.'
    stage.value = 'done'
  }
}

/* ------------------------------------------------------------------ */
/* W10 flow helpers (opt-in → questions → swipe-peek → save).          */
/* ------------------------------------------------------------------ */

/** The text the user added after a snapshot — the free-written response delta. */
function responseDeltaSince(snapshot: string): string | null {
  const delta = content.value.slice(snapshot.length).trim()
  return delta.length > 0 ? delta : null
}

/** Mark the live question resolved with its captured response (or null on skip). */
function resolveCurrentStep(response: string | null): void {
  const step = currentStep.value
  if (!step || step.resolved) return
  step.response = response
  step.resolved = true
}

/** Turn every asked step into a persistable draft; unresolved ones capture the delta now. */
function resolveFollowupDrafts(): FollowupResponseInput[] {
  return askedFollowups.value.map((step) => ({
    entryId: '',
    question: step.question,
    response: step.resolved ? step.response : responseDeltaSince(step.snapshot),
    referencedEntryIds: step.referencedEntryIds,
  }))
}

/** "No thanks — just save": close the opt-in; the entry is still savable below. */
function declineFollowup(): void {
  followupDeclined.value = true
  followupStage.value = 'off'
  focusEditor()
}

/** "Yes, ask me something": ensure the model, then present the first question. */
async function acceptFollowup(): Promise<void> {
  followupStage.value = 'loading'
  if (status.value.state === 'ready') {
    await presentNextQuestion()
    return
  }
  // Kick off the load. On failure the ModelGate sheet stays mounted showing
  // Retry / "Not now" — we deliberately do NOT tear the flow down here
  // (tearing it down unmounts the gate and makes the error invisible: the
  // "loading bar then nothing" bug). When the model becomes ready (first
  // download or a successful Retry) the watcher below presents Q1.
  void ensureReady()
}

/**
 * Present the first question the moment the model actually becomes ready,
 * whether from the first download or a successful Retry on the error sheet.
 * Only ever fires while we're still waiting (stage 'loading'), so the ask
 * happens exactly once per accept — no double-generation.
 */
watch(
  () => status.value.state,
  (state) => {
    if (followupStage.value === 'loading' && state === 'ready' && !gateDeclined.value) {
      void presentNextQuestion()
    }
  },
)

/** ModelGate's "Not now" fired: back to the plain textarea, entry still savable. */
function onGateDismissed(): void {
  gateDeclined.value = true
  followupDeclined.value = true
  followupStage.value = 'off'
  stage.value = 'writing'
  focusEditor()
}

/** Load up to two recent previous entries as grounding context (D6 references). */
async function loadRecentEntriesForFollowup(): Promise<FollowupContextEntry[]> {
  const recent = await listRecentEntries(FOLLOWUP_MAX_REFERENCED_ENTRIES)
  return recent.map((entry) => ({
    id: entry.id,
    content: entry.content,
    createdAt: entry.createdAt,
    label: describeReferencedEntry(entry.createdAt),
  }))
}

/** Relative label for a referenced entry, e.g. "Monday's entry" (frame 07 copy). */
function describeReferencedEntry(createdAt: string): string {
  const weekday = new Date(createdAt).toLocaleDateString(undefined, { weekday: 'long' })
  return `${weekday}'s entry`
}

/** Generate + show the next question. The caller gates it to max 2 (T2). */
async function presentNextQuestion(): Promise<void> {
  followupStage.value = 'loading'
  try {
    const previousEntries = await loadRecentEntriesForFollowup()
    const question = await generateFollowUpQuestion({
      entryContent: content.value,
      previousEntries,
    })
    askedFollowups.value.push({
      question: question.text,
      referencedEntryIds: question.referencedEntryIds,
      snapshot: content.value, // the response = anything written after this point
      response: null,
      resolved: false,
    })
    followupStage.value = 'question'
    peekOpen.value = false
    void loadPeekEntries(question.referencedEntryIds)
  } catch (error) {
    // Generation failure is not a data emergency — but never vanish silently.
    console.error('Follow-up generation failed:', error)
    if (askedFollowups.value.length === 0) {
      // No question ever appeared: show a gentle inline note instead of
      // silently dropping the flow (the "loading bar then nothing" bug).
      followupStage.value = 'failed'
    } else {
      // A later question failed: keep what we have, just stop asking for more.
      followupEligible.value = false
      followupStage.value = 'off'
    }
  }
}

/** "Skip this question" — mark the live question answered-with-nothing. */
function skipCurrentQuestion(): void {
  resolveCurrentStep(null)
  focusEditor()
}

/** "One more?" — finalize the live question (capturing its delta), then ask again. */
async function askOneMore(): Promise<void> {
  if (!canAskFollowup(askedFollowups.value.length)) return
  const step = currentStep.value
  if (step && !step.resolved) {
    resolveCurrentStep(responseDeltaSince(step.snapshot))
  }
  await presentNextQuestion()
}

/** "Close this out" — capture any in-progress response, then stop asking. */
function closeFollowupBlock(): void {
  const step = currentStep.value
  if (step && !step.resolved) {
    resolveCurrentStep(responseDeltaSince(step.snapshot))
  }
  followupEligible.value = false
  followupStage.value = 'off'
  focusEditor()
}

/** Fetch the decrypted referenced entries for the swipe-peek panel (D6). */
async function loadPeekEntries(ids: string[]): Promise<void> {
  if (ids.length === 0) {
    peekEntries.value = []
    return
  }
  const resolved: DecryptedEntry[] = []
  for (const id of ids) {
    const entry = await getEntry(id)
    if (entry) resolved.push(entry)
  }
  peekEntries.value = resolved
}

function peekDragStart(event: PointerEvent): void {
  peekDragStartY.value = event.clientY
}

function peekDragMove(event: PointerEvent): void {
  if (peekDragStartY.value === null) return
  const deltaY = event.clientY - peekDragStartY.value
  if (deltaY >= PEEK_DRAG_TRIGGER_PX) {
    peekOpen.value = true
  } else if (deltaY <= -PEEK_DRAG_TRIGGER_PX) {
    peekOpen.value = false
  }
}

function peekDragEnd(): void {
  peekDragStartY.value = null
}

function togglePeek(): void {
  peekOpen.value = !peekOpen.value
}


/** "Back to your journal" — the entry is saved; return to the dashboard. */
function goToDashboard() {
  crisisPanel.value = null
  void router.push('/')
}

/** "I'm okay — keep writing" — hide the card and open a fresh blank page. */
function keepWriting() {
  crisisPanel.value = null
  stage.value = 'writing'
  content.value = ''
  selectedMood.value = ''
  nudge.value = 'Saved.'
  // Close the stuck-prompt card too — a fresh entry must not inherit the
  // previous entry's prompt or its shown-history (T8 per-entry non-repeat).
  stuckState.value = null
  resetFollowupFlow()
  focusEditor()
}

/**
 * Stuck ("stuck?" affordance): open the aside card. Tier 1 (meaningful
 * theme) is model-phrased: the gate loads the model, which turns the
 * theme + its mention entries into ONE open question; the template pool
 * is the standing fallback whenever the model is unavailable. Tier 2
 * (no meaningful history) is the generic pool — model-free. A summary
 * read failure quietly lands on tier 2 (W9, flow.md).
 */
async function revealStuckPrompt() {
  if (stuckState.value) return
  const seed = await countEntries()
  let themes: Theme[] = []
  try {
    themes = await getThemes()
  } catch (error) {
    // A summary read failure is not a stuck-path emergency: fall back to
    // the generic pool with no error surface (getThemes itself returns []
    // on unreadable rows; this guards the unexpected-throw case too).
    console.error('Failed to load themes for a stuck prompt:', error)
  }
  const themeSet = buildThemedStuckPrompts(themes, seed)
  stuckState.value = startStuckPromptFlow(themeSet?.prompts ?? [], seed)
  stuckTheme.value = themeSet?.theme ?? null
  stuckModelQuestion.value = ''
  stuckThinking.value = false
  stuckGateDeclined.value = false
  nudge.value = null
  if (themeSet) {
    // Tier 1: model first. The template question for this position stands
    // while the gate loads — and stays if the model never arrives.
    void refreshThemedModelQuestion(themeSet.theme)
  }
}

/**
 * One model attempt for the CURRENT themed rotation position: ensure the
 * model (the gate sheet covers the download), then phrase a fresh question
 * from the theme + up to two entries that mention it. Every failure — not
 * downloaded, gate declined, generation rejected after its retry — leaves
 * the template question standing; never an error, never a dead end.
 */
async function refreshThemedModelQuestion(theme: Theme): Promise<void> {
  const requestId = ++stuckQuestionRequest
  const ready = await ensureReady()
  if (!ready || stuckGateDeclined.value) return
  stuckThinking.value = true
  try {
    const recent = await listRecentEntries(STUCK_THEME_SCAN_LIMIT)
    const mentionEntries = selectMentionEntries(recent, theme.topic)
    const question = await generateThemedQuestion({ theme, mentionEntries })
    // The card may have advanced or closed while the model worked — only
    // the latest request paints, and only while still in tier 1.
    if (stuckState.value?.tier === 'themed' && requestId === stuckQuestionRequest) {
      stuckModelQuestion.value = question.text
    }
  } catch (error) {
    // Model garbage or failure after its retry — the template stands.
    console.error('Themed question generation failed; keeping the template:', error)
  } finally {
    if (requestId === stuckQuestionRequest) stuckThinking.value = false
  }
}

/**
 * "Not this one" — tier-aware. Tier 1 advances the themed rotation and
 * asks the model for a fresh question (template stands as the fallback);
 * tier 2 just walks the generic pool. The themed tier is bounded, then
 * falls through to tier 2 — never a dead end, never two generations at once.
 */
function cycleStuckPrompt() {
  const flow = stuckState.value
  if (!flow || stuckThinking.value) return
  stuckModelQuestion.value = ''
  const next = advanceStuckPromptFlow(flow)
  stuckState.value = next
  if (next.tier === 'themed' && stuckTheme.value && !stuckGateDeclined.value) {
    void refreshThemedModelQuestion(stuckTheme.value)
  }
}

/** ModelGate's "Not now" on the stuck gate: keep the themed card, drop the model. */
function onStuckGateDismissed(): void {
  stuckGateDeclined.value = true
}

function closeStuckCard() {
  stuckState.value = null
  focusEditor()
}
</script>

<template>
  <!-- Frames 02/03/05 — New Entry (docs/example-journal-first.html) -->
  <div class="new-entry">
    <div class="app-header">
      <div class="app-title">New entry</div>
      <div class="app-date">{{ headerDate }}</div>
    </div>

    <div class="entry-meta">
      <span>{{ liveTime }}</span>
      <span class="meta-status">{{ metaStatus }}</span>
      <button
        v-if="stage === 'writing'"
        type="button"
        class="stuck-link"
        aria-label="I don't know what to write"
        @click="revealStuckPrompt"
      >
        stuck?
      </button>
    </div>

    <!-- Frames 03/04 — stuck · generic or from memory: light aside card, never
         blocks writing. Tier 1 (themed) is model-phrased: the gate loads the
         model, whose question replaces the template while it loads; "Not this
         one" advances the themed rotation (regenerating when the model is up),
         then falls through to tier 2 (generic pool). The gate's SHEET is
         active only for the themed card, so it can never collide with the
         follow-up gate's sheet; the slot (the card) always renders. -->
    <ModelGate
      :active="stuckState !== null && stage === 'writing' && stuckIsThemed"
      @dismissed="onStuckGateDismissed"
    >
      <div
        v-if="stuckState && stage === 'writing'"
        class="aside-card"
        :class="{ 'from-memory': stuckIsThemed }"
      >
        <div class="aside-eyebrow">{{ stuckEyebrow }}</div>
        <div class="aside-q" :class="{ thinking: stuckIsThemed && stuckThinking }">
          {{ stuckPrompt }}
        </div>
        <div class="aside-actions">
          <button type="button" class="chip" @click="cycleStuckPrompt">Not this one, give me another</button>
          <button type="button" class="chip skip" @click="closeStuckCard">Just a plain page</button>
        </div>
      </div>
    </ModelGate>
    <!-- W10 follow-up block (D5/D6/T2): opt-in → up to 2 questions → swipe-peek.
         Everything here is opt-in and nothing ever blocks saving the entry. -->
    <div v-if="showFollowupBlock" class="followup-block">
      <ModelGate title="Warming up your private AI" @dismissed="onGateDismissed">
        <!-- Stage A — opt-in (D5: the model has NOT generated anything yet here) -->
        <div v-if="followupStage === 'offer'" class="aside-card followup-card">
          <div class="aside-eyebrow">Want to talk about this?</div>
          <div class="aside-q">A gentle question can help it settle. No pressure either way.</div>
          <div class="aside-actions column">
            <button type="button" class="btn btn-primary btn-full followup-yes" @click="acceptFollowup">
              Yes, ask me something
            </button>
            <button type="button" class="btn ghost btn-full followup-no" @click="declineFollowup">
              No thanks — just save
            </button>
          </div>
        </div>

        <!-- Generating / first-run download — the ModelGate sheet covers the download -->
        <div v-else-if="followupStage === 'loading'" class="aside-card followup-loading">
          <div class="aside-q">One quick thing…</div>
        </div>

        <!-- Stage B — one question (frame 06) -->
        <div v-else-if="followupStage === 'question' && currentStep" class="aside-card followup-card">
          <div class="aside-eyebrow">One quick thing <span class="aside-count">{{ askedFollowups.length }} of {{ FOLLOWUP_MAX_QUESTIONS }}</span></div>
          <div class="aside-q followup-question">{{ currentStep.question }}</div>

          <!-- Swipe-peek handle (D6): pull down to see what the question references -->
          <button
            v-if="showPeekAffordance"
            type="button"
            class="peek-handle"
            :class="{ open: peekOpen }"
            :aria-expanded="peekOpen"
            @click="togglePeek"
            @pointerdown="peekDragStart"
            @pointermove="peekDragMove"
            @pointerup="peekDragEnd"
          >
            <span class="peek-handle-bar"></span>
            <span class="peek-handle-label">peek at earlier entry</span>
          </button>

          <div class="aside-actions column">
            <button
              v-if="!currentStep.resolved"
              type="button"
              class="btn ghost btn-full followup-skip"
              @click="skipCurrentQuestion"
            >
              Skip this question
            </button>
            <button
              v-if="canAskFollowup(askedFollowups.length) && currentStepAnswered"
              type="button"
              class="btn ghost btn-full followup-more"
              @click="askOneMore"
            >
              One more?
            </button>
            <button type="button" class="link followup-close" @click="closeFollowupBlock">
              Close this out
            </button>
          </div>
        </div>

        <!-- Generation couldn't produce a question — gentle, never a silent vanish -->
        <div v-else-if="followupStage === 'failed'" class="aside-card followup-card">
          <div class="aside-q">I couldn't think of a question this time — no problem. Save whenever you're ready.</div>
          <div class="aside-actions column">
            <button type="button" class="link followup-close" @click="closeFollowupBlock">
              Close this out
            </button>
          </div>
        </div>
      </ModelGate>

      <!-- Swipe-peek panel (frame 07): read-only, "swipe ↑ to put it away" -->
      <div
        v-if="followupStage === 'question' && peekOpen && peekEntries.length > 0"
        class="peek-panel"
      >
        <button
          type="button"
          class="peek-grabber"
          aria-label="Put the peek panel away"
          @click="togglePeek"
          @pointerdown="peekDragStart"
          @pointermove="peekDragMove"
          @pointerup="peekDragEnd"
        ></button>
        <div v-for="entry in peekEntries" :key="entry.id" class="peek-entry">
          <div class="peek-label">{{ describeReferencedEntry(entry.createdAt) }} · pulled up for context</div>
          <div class="peek-title">{{ deriveTitle(entry.content, entry.createdAt) }}</div>
          <div class="peek-body">{{ entry.content }}</div>
        </div>
        <div class="peek-hint">swipe ↑ to put it away</div>
      </div>
    </div>

    <textarea
      ref="editorRef"
      v-model="content"
      class="entry-sheet"
      placeholder="What's on your mind…"
      aria-label="Journal entry"
      spellcheck="false"
    ></textarea>

    <p v-if="nudge" class="nudge" role="status">{{ nudge }}</p>
    <p v-if="loadError" class="load-error" role="alert">{{ loadError }}</p>

    <div class="finish-bar">
      <!-- Writing stage: single Done action (frame 02) -->
      <button v-if="stage === 'writing'" type="button" class="btn btn-primary btn-full" @click="handleDone">
        Done
      </button>

      <!-- Done stage (frame 05): mood, then save — W10 follow-up seam sits above -->
      <template v-else>
        <div class="finish-label">How did today feel?</div>
        <div class="mood-inline">
          <button
            v-for="mood in MOODS"
            :key="mood"
            type="button"
            class="mood-option"
            :class="{ selected: selectedMood === mood }"
            :aria-pressed="selectedMood === mood"
            @click="selectedMood = mood"
          >
            {{ mood }}
          </button>
        </div>
        <button
          type="button"
          class="btn btn-primary btn-full"
          :disabled="stage === 'saving'"
          @click="handleSave"
        >
          {{ stage === 'saving' ? 'Saving…' : 'Save entry' }}
        </button>
        <button type="button" class="back-link" @click="backToWriting">← Keep editing</button>
      </template>
    </div>

    <!-- Crisis resource card: appears only after a tripped save; never blocks it -->
    <div v-if="crisisPanel" class="crisis-overlay" role="dialog" aria-label="Support resources">
      <div class="crisis-card">
        <div class="crisis-eyebrow">Support</div>
        <div class="crisis-headline">{{ crisisPanel.headline }}</div>
        <div v-for="resource in crisisPanel.resources" :key="resource.id" class="crisis-resource">
          <div class="crisis-name">{{ resource.name }}</div>
          <div class="crisis-note">{{ resource.note }}</div>
          <div v-if="resource.phone" class="crisis-phone">{{ resource.phone }}</div>
        </div>
        <div class="crisis-actions">
          <button type="button" class="btn btn-primary btn-full" @click="goToDashboard">
            Back to your journal
          </button>
          <button type="button" class="chip skip btn-full" @click="keepWriting">
            I'm okay — keep writing
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* Mirrors the wireframe's 02/03/05 frames; tokens come from main.css. */

.new-entry {
  display: flex;
  flex-direction: column;
  min-height: calc(100dvh - 124px);
}

/* ---- Header (frame 02) ---- */
.app-header {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  margin-bottom: var(--space-4);
}

.app-title {
  font-family: 'Fraunces', serif;
  font-size: 26px;
  font-weight: 500;
  letter-spacing: -0.01em;
}

.app-date {
  font-family: 'JetBrains Mono', monospace;
  font-size: 11px;
  color: var(--text-muted);
}

/* ---- Meta row ---- */
.entry-meta {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--space-2);
  font-family: 'JetBrains Mono', monospace;
  font-size: 10px;
  color: #55503f;
  margin-bottom: var(--space-3);
}

.stuck-link {
  background: none;
  border: none;
  padding: 0;
  font-family: 'JetBrains Mono', monospace;
  font-size: 10px;
  color: #55503f;
  cursor: pointer;
  border-bottom: 1px dashed #55503f;
}

.stuck-link:hover {
  color: var(--accent);
  border-bottom-color: var(--accent);
}

/* ---- Dominant writing surface ---- */
.entry-sheet {
  flex: 1;
  width: 100%;
  min-height: 40vh;
  background: transparent;
  border: none;
  resize: none;
  outline: none;
  color: var(--text);
  font-family: 'Fraunces', serif;
  font-size: 17px;
  line-height: 1.75;
  letter-spacing: 0.005em;
}

.entry-sheet::placeholder {
  color: #5a5648;
}

/* ---- Aside card (stuck prompt — never blocks writing; frame 03) ---- */
.aside-card {
  background: var(--surface);
  border: 1px solid var(--border);
  border-left: 2px solid var(--calm);
  border-radius: var(--radius-md);
  padding: var(--space-3);
  margin-bottom: var(--space-4);
  flex-shrink: 0;
}

.aside-eyebrow {
  font-family: 'JetBrains Mono', monospace;
  font-size: 9.5px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--calm);
  margin-bottom: 6px;
}

.aside-q {
  font-family: 'Fraunces', serif;
  font-size: 15.5px;
  line-height: 1.5;
  margin-bottom: 10px;
}

.aside-actions {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}

.chip {
  font-family: 'JetBrains Mono', monospace;
  font-size: 10.5px;
  color: var(--text-muted);
  border: 1px solid var(--border);
  border-radius: 20px;
  padding: 5px 11px;
  background: none;
  cursor: pointer;
}

.chip:hover {
  border-color: var(--calm);
}

/* Frame 04 — the "from your recent entries" card shifts to the amber accent. */
.aside-card.from-memory {
  border-left-color: var(--accent);
}

.aside-card.from-memory .aside-eyebrow {
  color: var(--accent);
}

/* Light "thinking…" state while the model phrases the themed question. */
.aside-q.thinking {
  font-family: 'JetBrains Mono', monospace;
  font-size: 11px;
  color: var(--text-muted);
}

.chip.skip {
  color: #55503f;
}

/* ---- W10 follow-up block (D5/D6: opt-in, never blocks writing or saving) ---- */
.followup-block {
  flex-shrink: 0;
}

.aside-actions.column {
  flex-direction: column;
}

.aside-count {
  color: var(--accent);
}

/* Full-width ghost choice — equal prominence to the amber primary. */
.btn.ghost {
  background: transparent;
  border: 1px solid var(--border);
  color: var(--text-muted);
  font-weight: 500;
}

.btn.ghost:hover {
  color: var(--text);
  border-color: var(--text-muted);
}

/* Small text link — "Close this out" (skip ≥ respond, no dark patterns). */
.link {
  background: none;
  border: none;
  padding: 4px 0;
  font-family: 'JetBrains Mono', monospace;
  font-size: 10px;
  color: #55503f;
  cursor: pointer;
  text-align: center;
}

.link:hover {
  color: var(--text-muted);
}

.followup-loading .aside-q {
  font-family: 'JetBrains Mono', monospace;
  font-size: 11px;
  color: var(--text-muted);
}

/* ---- Swipe-peek (D6): grabber handle + read-only referenced-entry panel ---- */
.peek-handle {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 4px 0 8px;
  background: none;
  border: none;
  cursor: grab;
}

.peek-handle:focus-visible {
  outline: 1px solid var(--accent);
}

.peek-handle-bar {
  width: 40px;
  height: 4px;
  border-radius: 2px;
  background: var(--border);
  flex-shrink: 0;
}

.peek-handle-label {
  font-family: 'JetBrains Mono', monospace;
  font-size: 9.5px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: #55503f;
}

.peek-handle.open .peek-handle-bar {
  background: var(--accent);
}

.peek-panel {
  background: var(--surface-raised);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  padding: 10px var(--space-3) var(--space-3);
  margin-bottom: var(--space-4);
  flex-shrink: 0;
}

.peek-grabber {
  display: block;
  width: 40px;
  height: 4px;
  border-radius: 2px;
  background: var(--border);
  border: none;
  padding: 0;
  margin: 0 auto 10px;
  cursor: grab;
}

.peek-grabber:hover {
  background: var(--text-muted);
}

.peek-entry {
  margin-bottom: var(--space-2);
}

.peek-label {
  font-family: 'JetBrains Mono', monospace;
  font-size: 9.5px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--accent);
  margin-bottom: 6px;
}

.peek-title {
  font-family: 'Fraunces', serif;
  font-size: 15px;
  font-weight: 500;
  margin-bottom: 6px;
}

.peek-body {
  font-size: 12.5px;
  line-height: 1.6;
  color: var(--text-muted);
  white-space: pre-wrap;
  word-break: break-word;
  display: -webkit-box;
  -webkit-line-clamp: 4;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.peek-hint {
  font-family: 'JetBrains Mono', monospace;
  font-size: 9px;
  color: #55503f;
  text-align: center;
  margin-top: 10px;
}

/* ---- Nudges & errors ---- */
.nudge {
  font-family: 'Fraunces', serif;
  font-size: 13px;
  color: var(--text-muted);
  text-align: center;
  margin: var(--space-2) 0;
}

.load-error {
  font-family: 'JetBrains Mono', monospace;
  font-size: 10.5px;
  color: var(--crisis);
  text-align: center;
  margin: var(--space-2) 0;
}

/* ---- Finish bar (frames 02/05) ---- */
.finish-bar {
  flex-shrink: 0;
  background: rgba(21, 19, 15, 0.96);
  backdrop-filter: blur(10px);
  border-top: 1px solid var(--border);
  padding-top: var(--space-3);
  margin-top: var(--space-3);
}

.finish-label {
  font-family: 'JetBrains Mono', monospace;
  font-size: 10px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: #55503f;
  text-align: center;
  margin-bottom: 8px;
}

.mood-inline {
  display: flex;
  gap: 6px;
  margin-bottom: var(--space-3);
  justify-content: center;
}

.mood-option {
  font-size: 16px;
  background: none;
  border: 1px solid var(--border);
  border-radius: 20px;
  padding: 4px 9px;
  opacity: 0.55;
  cursor: pointer;
}

.mood-option.selected {
  opacity: 1;
  border-color: var(--accent);
  background: var(--accent-soft);
}

.back-link {
  display: block;
  width: 100%;
  margin-top: var(--space-2);
  background: none;
  border: none;
  font-family: 'JetBrains Mono', monospace;
  font-size: 10px;
  color: #55503f;
  cursor: pointer;
  text-align: center;
  padding: 4px;
}

.back-link:hover {
  color: var(--text-muted);
}

/* ---- Buttons ---- */
.btn {
  font-family: 'Work Sans', sans-serif;
  font-size: 14px;
  font-weight: 600;
  border: none;
  border-radius: var(--radius-sm);
  padding: 11px 18px;
  cursor: pointer;
}

.btn-primary {
  background: var(--accent);
  color: #1a1408;
}

.btn-primary:disabled {
  opacity: 0.55;
  cursor: default;
}

.btn-full {
  width: 100%;
}

/* ---- Crisis resource card (post-save, dismissible, never blocks the save) ---- */
.crisis-overlay {
  position: fixed;
  inset: 0;
  z-index: 20;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: var(--space-4);
  background: rgba(21, 19, 15, 0.72);
  animation: crisis-fade-in 240ms ease-out;
}

.crisis-card {
  background: var(--surface-raised);
  border: 1px solid var(--border);
  border-left: 2px solid var(--crisis);
  border-radius: var(--radius-lg);
  padding: var(--space-4);
  width: 100%;
  max-width: 380px;
  max-height: 80dvh;
  overflow-y: auto;
}

.crisis-eyebrow {
  font-family: 'JetBrains Mono', monospace;
  font-size: 9.5px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--crisis);
  margin-bottom: 6px;
}

.crisis-headline {
  font-family: 'Fraunces', serif;
  font-size: 17px;
  line-height: 1.45;
  margin-bottom: var(--space-3);
}

.crisis-resource {
  border-top: 1px solid var(--border);
  padding: var(--space-2) 0 var(--space-3);
}

.crisis-name {
  font-family: 'Fraunces', serif;
  font-size: 14px;
  font-weight: 500;
  margin-bottom: 2px;
}

.crisis-note {
  font-size: 12.5px;
  line-height: 1.55;
  color: var(--text-muted);
}

.crisis-phone {
  font-family: 'JetBrains Mono', monospace;
  font-size: 11px;
  color: var(--accent);
  margin-top: 4px;
}

.crisis-actions {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  margin-top: var(--space-3);
}

@keyframes crisis-fade-in {
  from {
    opacity: 0;
  }
  to {
    opacity: 1;
  }
}

@media (prefers-reduced-motion: reduce) {
  .crisis-overlay {
    animation: none;
  }
}
</style>