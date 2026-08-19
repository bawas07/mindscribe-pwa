<script setup lang="ts">
/**
 * W7 — Entry detail (no wireframe frame; consistent with the same system):
 * back link, date + mood header, the full decrypted entry in Fraunces,
 * and follow-up Q&A appended inline as muted asides (decision T2) — only
 * when the entry actually has follow-ups (W10 seam renders nothing here
 * until rows exist).
 */
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import { formatMonthLabel } from '../../lib/calendar'
import { getEntry, listFollowupsForEntry } from '../../lib/entries'
import type { DecryptedEntry, DecryptedFollowup } from '../../lib/entries'

const route = useRoute()

const entry = ref<DecryptedEntry | null>(null)
const followups = ref<DecryptedFollowup[]>([])
const notFound = ref(false)
const loadError = ref<string | null>(null)

/** Local date, e.g. "17 August 2026 · 08:42" — the detail header. */
const dateLabel = computed(() => {
  if (!entry.value) return ''
  const date = new Date(entry.value.createdAt)
  const day = String(date.getDate()).padStart(2, '0')
  const hours = String(date.getHours()).padStart(2, '0')
  const minutes = String(date.getMinutes()).padStart(2, '0')
  return `${day} ${formatMonthLabel(date.getFullYear(), date.getMonth())} · ${hours}:${minutes}`
})

/**
 * Loads one entry + its follow-ups, resetting stale view state first.
 * Shared by onMounted and the route-param watch so an id→id navigation
 * never shows the previously viewed entry.
 */
async function loadEntry(id: string) {
  entry.value = null
  followups.value = []
  notFound.value = false
  loadError.value = null
  try {
    const loaded = await getEntry(id)
    if (!loaded) {
      notFound.value = true
      return
    }
    // Authoritative source: actual rows, not the hasFollowup flag (which
    // W10 maintains) — the seam renders nothing when there are none. Both
    // awaits settle before either ref is written so the entry and its inline
    // follow-ups render atomically (no flash of entry-without-replies).
    const followupsForEntry = await listFollowupsForEntry(id)
    entry.value = loaded
    followups.value = followupsForEntry
  } catch (error) {
    // Never swallow: a decrypt failure must surface, not render as blank.
    console.error('Failed to load entry:', error)
    loadError.value = 'We could not load this entry. Please try again.'
  }
}

onMounted(() => {
  void loadEntry(String(route.params.id ?? ''))
})

// Re-load when the id in the URL changes (entry → entry navigation) so the
// view shows the newly requested entry rather than stale content.
watch(
  () => route.params.id,
  (id) => {
    void loadEntry(String(id ?? ''))
  },
)
</script>

<template>
  <div class="entry-detail">
    <div class="detail-top">
      <router-link to="/history" class="back-link">← Back</router-link>
    </div>

    <p v-if="loadError" class="load-error" role="alert">{{ loadError }}</p>
    <div v-else-if="notFound" class="empty-note">
      This entry no longer exists.
    </div>

    <template v-else-if="entry">
      <div class="app-header">
        <div class="app-date">{{ dateLabel }}</div>
        <div v-if="entry.moodEmoji" class="detail-mood" aria-hidden="true">{{ entry.moodEmoji }}</div>
      </div>

      <article class="entry-text">{{ entry.content }}</article>

      <!-- Follow-ups (decision T2): appended inline, muted asides. Nothing
           renders when the entry has no follow-ups (W10 seam). -->
      <aside v-for="followup in followups" :key="followup.id" class="followup-aside">
        <div class="followup-re">re: {{ followup.question }}</div>
        <div v-if="followup.response" class="followup-response">{{ followup.response }}</div>
      </aside>
    </template>
  </div>
</template>

<style scoped>
/* Consistent with the dashboard/history system; tokens from main.css. */

.detail-top {
  margin-bottom: var(--space-4);
}

.back-link {
  font-family: 'JetBrains Mono', monospace;
  font-size: 11px;
  color: var(--text-muted);
  text-decoration: none;
  cursor: pointer;
}

.back-link:hover {
  color: var(--accent);
}

.app-header {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  margin-bottom: var(--space-4);
}

.app-date {
  font-family: 'JetBrains Mono', monospace;
  font-size: 11px;
  color: var(--text-muted);
}

.detail-mood {
  font-size: 22px;
  line-height: 1;
}

/* ---- Writing surface — same generous Fraunces as the editor ---- */
.entry-text {
  font-family: 'Fraunces', serif;
  font-size: 17px;
  line-height: 1.75;
  letter-spacing: 0.005em;
  color: var(--text);
  white-space: pre-wrap;
  word-break: break-word;
}

/* ---- Follow-ups (T2): muted aside, question with a subtle "re:" ---- */
/* NOTE: the "re:" marker is plain text in the template (exactly one
   occurrence). No ::before content rule may be added here — it would
   render a duplicate "re: re:" in real browsers. */
.followup-aside {
  margin-top: var(--space-4);
  background: var(--surface);
  border: 1px solid var(--border);
  border-left: 2px solid var(--calm);
  border-radius: var(--radius-md);
  padding: var(--space-3) var(--space-3);
}

.followup-re {
  font-family: 'Fraunces', serif;
  font-style: italic;
  font-size: 15px;
  line-height: 1.5;
  color: var(--text);
  margin-bottom: var(--space-2);
}

.followup-response {
  font-size: 13.5px;
  line-height: 1.6;
  color: var(--text-muted);
  white-space: pre-wrap;
  word-break: break-word;
}

.empty-note {
  font-family: 'Fraunces', serif;
  font-size: 14px;
  color: var(--text-muted);
  text-align: center;
  padding: var(--space-5) var(--space-2);
}

.load-error {
  font-family: 'JetBrains Mono', monospace;
  font-size: 10.5px;
  color: var(--crisis);
  text-align: center;
}
</style>