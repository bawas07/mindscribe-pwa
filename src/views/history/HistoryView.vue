<script setup lang="ts">
/**
 * W7 — History list (wireframe frame 08): search, month-grouped rows,
 * inline delete confirm, rows wired to /history/:id.
 */
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { formatEntryTimestamp } from '../../lib/calendar'
import { deleteEntry, listEntrySummaries } from '../../lib/entries'
import type { EntrySummary, MonthlyEntryGroup } from '../../lib/entries'
import { scheduleSummaryRegeneration } from '../../lib/model/summary'

const router = useRouter()

const groups = ref<MonthlyEntryGroup[]>([])
const searchQuery = ref('')
const loadError = ref<string | null>(null)
/** Id of the row awaiting delete confirmation — null = no confirm open. */
const confirmingId = ref<string | null>(null)
/** Recoverable per-row delete errors — a failed delete never hides the list. */
const deleteErrors = ref<Record<string, string>>({})

/** Client-side search over title + snippet, case-insensitive (plan W7 AC). */
const filteredGroups = computed(() => {
  const query = searchQuery.value.trim().toLowerCase()
  if (!query) return groups.value

  return groups.value
    .map((group) => ({
      ...group,
      entries: group.entries.filter(
        (entry) =>
          entry.title.toLowerCase().includes(query) ||
          entry.snippet.toLowerCase().includes(query),
      ),
    }))
    .filter((group) => group.entries.length > 0)
})

async function loadGroups() {
  try {
    groups.value = await listEntrySummaries()
    loadError.value = null
  } catch (error) {
    console.error('Failed to load history:', error)
    loadError.value = 'We could not load your entries. Please reload the app.'
  }
}

function openEntry(entry: EntrySummary) {
  // While its confirm bar is open, clicking the body shouldn't navigate.
  if (confirmingId.value === entry.id) return
  void router.push(`/history/${entry.id}`)
}

/** Toggles the inline confirm on a row — no window.confirm needed for M1. */
function askDelete(entry: EntrySummary) {
  confirmingId.value = confirmingId.value === entry.id ? null : entry.id
  // Opening the confirm replaces any stale error for this row.
  dismissDeleteError(entry)
}

function cancelDelete() {
  confirmingId.value = null
}

/** Re-opens the in-place confirm so the user can retry or back out. */
function retryDelete(entry: EntrySummary) {
  dismissDeleteError(entry)
  confirmingId.value = entry.id
}

function dismissDeleteError(entry: EntrySummary) {
  if (!deleteErrors.value[entry.id]) return
  const next = { ...deleteErrors.value }
  delete next[entry.id]
  deleteErrors.value = next
}

async function confirmDelete(entry: EntrySummary) {
  confirmingId.value = null // close the confirm bar regardless of outcome
  try {
    await deleteEntry(entry.id)
    // W7 delete → regen seam (plan T1): a deletion invalidates the rolling
    // summary. W11 owns the actual regeneration; here we only schedule it.
    void scheduleSummaryRegeneration('entry-deleted')
    dismissDeleteError(entry)
    await loadGroups()
  } catch (error) {
    // Never swallow: a failed delete keeps the row + the whole list visible,
    // with a dismissible per-row error and a Retry affordance — not a dead-end.
    console.error('Failed to delete entry:', error)
    deleteErrors.value = {
      ...deleteErrors.value,
      [entry.id]: 'We could not delete that entry. Please try again.',
    }
  }
}

onMounted(() => {
  void loadGroups()
})
</script>

<template>
  <!-- Frame 08 — History (docs/example-journal-first.html) -->
  <div class="history">
    <div class="app-header">
      <div class="app-title">History</div>
    </div>

    <input
      v-model="searchQuery"
      type="search"
      class="history-search"
      placeholder="Search entries…"
      aria-label="Search entries"
    />

    <p v-if="loadError" class="load-error" role="alert">{{ loadError }}</p>
    <p v-else-if="groups.length === 0" class="empty-note">
      Nothing here yet. Your saved entries will show up here.
    </p>
    <p v-else-if="filteredGroups.length === 0" class="empty-note">
      No entries match your search.
    </p>

    <template v-for="group in filteredGroups" :key="group.monthLabel">
      <div class="history-month-label">{{ group.monthLabel }}</div>

      <template v-for="entry in group.entries" :key="entry.id">
        <div
          class="entry-row"
          role="link"
          tabindex="0"
          @click="openEntry(entry)"
          @keydown.enter="openEntry(entry)"
        >
          <div class="entry-mood" aria-hidden="true">{{ entry.moodEmoji || '·' }}</div>
          <div class="entry-body">
            <div class="entry-title">{{ entry.title }}</div>
            <div class="entry-snippet">{{ entry.snippet }}</div>
            <div class="entry-date">{{ formatEntryTimestamp(entry.createdAt) }}</div>
          </div>

          <!-- Inline confirm (wireframe's ✕ opens it; no window.confirm) -->
          <div v-if="confirmingId === entry.id" class="delete-confirm" @click.stop>
            <span class="confirm-text">Delete?</span>
            <button type="button" class="confirm-yes" @click.stop="confirmDelete(entry)">Delete</button>
            <button type="button" class="confirm-no" @click.stop="cancelDelete">Keep</button>
          </div>
          <button
            v-else
            type="button"
            class="entry-delete"
            aria-label="Delete entry"
            @click.stop="askDelete(entry)"
          >
            ✕
          </button>
        </div>

        <!-- Per-row delete failure: keeps the list alive, dismissible + retryable. -->
        <div v-if="deleteErrors[entry.id]" class="delete-error" role="alert">
          <span class="delete-error-text">{{ deleteErrors[entry.id] }}</span>
          <button type="button" class="delete-error-retry" @click="retryDelete(entry)">Retry</button>
          <button type="button" class="delete-error-dismiss" @click="dismissDeleteError(entry)">Dismiss</button>
        </div>
      </template>
    </template>
  </div>
</template>

<style scoped>
/* Mirrors the wireframe's 08 — History frame; tokens come from main.css. */

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

/* ---- Search ---- */
.history-search {
  width: 100%;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  padding: 10px 14px;
  color: var(--text);
  font-family: 'Work Sans', sans-serif;
  font-size: 13px;
  outline: none;
  margin-bottom: var(--space-4);
}

.history-search::placeholder {
  color: #5a5648;
}

.history-search:focus {
  border-color: var(--accent);
}

/* ---- Empty / error states ---- */
.empty-note {
  font-family: 'Fraunces', serif;
  font-size: 14px;
  color: var(--text-muted);
  text-align: center;
  padding: var(--space-4) var(--space-2);
}

.load-error {
  font-family: 'JetBrains Mono', monospace;
  font-size: 10.5px;
  color: var(--crisis);
  text-align: center;
  margin-bottom: var(--space-3);
}

/* ---- Month groups ---- */
.history-month-label {
  font-family: 'JetBrains Mono', monospace;
  font-size: 11px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--text-muted);
  margin: var(--space-3) 0 var(--space-1);
}

/* ---- Row (frame 08) ---- */
.entry-row {
  display: flex;
  align-items: flex-start;
  gap: var(--space-3);
  padding: var(--space-3) 0;
  border-bottom: 1px solid var(--border);
  cursor: pointer;
}

.entry-row:last-child {
  border-bottom: none;
}

.entry-row:hover .entry-title {
  color: var(--accent);
}

.entry-mood {
  font-size: 20px;
  line-height: 1;
  margin-top: 2px;
}

.entry-body {
  flex: 1;
  min-width: 0;
}

.entry-title {
  font-family: 'Fraunces', serif;
  font-size: 16px;
  font-weight: 500;
  margin-bottom: 2px;
}

.entry-snippet {
  font-size: 13px;
  color: var(--text-muted);
  line-height: 1.5;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.entry-date {
  font-family: 'JetBrains Mono', monospace;
  font-size: 10px;
  color: #55503f;
  margin-top: 6px;
}

/* ---- Delete affordance + inline confirm ---- */
.entry-delete {
  background: none;
  border: none;
  color: #55503f;
  font-size: 13px;
  line-height: 1;
  padding: 2px 4px;
  cursor: pointer;
  flex-shrink: 0;
}

.entry-delete:hover {
  color: var(--crisis);
}

.delete-confirm {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
}

.confirm-text {
  font-family: 'JetBrains Mono', monospace;
  font-size: 9.5px;
  color: var(--crisis);
}

.confirm-yes,
.confirm-no {
  font-family: 'JetBrains Mono', monospace;
  font-size: 10px;
  border: 1px solid var(--border);
  border-radius: 14px;
  padding: 3px 9px;
  cursor: pointer;
  background: none;
}

.confirm-yes {
  color: var(--crisis);
  border-color: var(--crisis);
}

.confirm-no {
  color: var(--text-muted);
}

.confirm-yes:hover {
  background: rgba(193, 102, 107, 0.14);
}

.confirm-no:hover {
  border-color: var(--text-muted);
}

/* ---- Per-row delete failure (keeps the list alive, never a dead-end) ---- */
.delete-error {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  padding: 0 0 var(--space-3);
  margin-top: -4px;
}

.delete-error-text {
  flex: 1;
  min-width: 180px;
  font-size: 12.5px;
  color: var(--crisis);
}

.delete-error-retry,
.delete-error-dismiss {
  font-family: 'JetBrains Mono', monospace;
  font-size: 10px;
  border: 1px solid var(--border);
  border-radius: 14px;
  padding: 3px 10px;
  cursor: pointer;
  background: none;
}

.delete-error-retry {
  color: var(--accent);
  border-color: var(--accent);
}

.delete-error-retry:hover {
  background: var(--accent-soft);
}

.delete-error-dismiss {
  color: var(--text-muted);
}

.delete-error-dismiss:hover {
  border-color: var(--text-muted);
}
</style>