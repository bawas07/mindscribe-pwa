<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import {
  buildMonthGrid,
  DAY_NAMES,
  formatEntryTimestamp,
  formatHeaderDate,
  formatMonthLabel,
} from '../lib/calendar'
import type { CalendarCell } from '../lib/calendar'
import {
  deriveSnippet,
  deriveTitle,
  listMonthEntries,
  listRecentEntries,
  moodForDay,
} from '../lib/entries'
import type { DecryptedEntry } from '../lib/entries'

const router = useRouter()

/** Month shown in the calendar (W5 AC: ‹ › month navigation). */
const visibleMonth = ref(new Date())
const monthEntries = ref<DecryptedEntry[]>([])
const recentEntries = ref<DecryptedEntry[]>([])
const loadError = ref<string | null>(null)

const headerDate = formatHeaderDate(new Date())

const monthLabel = computed(() =>
  formatMonthLabel(visibleMonth.value.getFullYear(), visibleMonth.value.getMonth()),
)

const grid = computed(() =>
  buildMonthGrid(visibleMonth.value.getFullYear(), visibleMonth.value.getMonth()),
)

/** Day-of-month → mood emoji (latest entry of the day wins, decision T3). */
const moodByDay = computed(() => {
  const moods = new Map<number, string>()
  for (const cell of grid.value) {
    if (cell.day === null) continue
    const mood = moodForDay(monthEntries.value, cell.day)
    if (mood) moods.set(cell.day, mood)
  }
  return moods
})

/** Days that have at least one entry — the amber dot marker. */
const entryDays = computed(
  () => new Set(monthEntries.value.map((entry) => new Date(entry.createdAt).getDate())),
)

function changeMonth(offset: number) {
  const current = visibleMonth.value
  visibleMonth.value = new Date(current.getFullYear(), current.getMonth() + offset, 1)
}

function cellClasses(cell: CalendarCell): string {
  if (cell.day === null) return 'cal-day-blank'
  const classes = ['cal-day']
  if (entryDays.value.has(cell.day)) classes.push('has-entry')
  if (moodByDay.value.has(cell.day)) classes.push('mood')
  if (cell.isToday) classes.push('today')
  return classes.join(' ')
}

function cellText(cell: CalendarCell): string | number {
  if (cell.day === null) return ''
  return moodByDay.value.get(cell.day) ?? cell.day
}

async function loadMonthEntries() {
  try {
    monthEntries.value = await listMonthEntries(
      visibleMonth.value.getFullYear(),
      visibleMonth.value.getMonth(),
    )
  } catch (error) {
    console.error('Failed to load calendar entries:', error)
    loadError.value = 'We could not load your entries. Please reload the app.'
  }
}

async function loadRecentEntries() {
  try {
    recentEntries.value = await listRecentEntries()
  } catch (error) {
    console.error('Failed to load recent entries:', error)
    loadError.value = 'We could not load your entries. Please reload the app.'
  }
}

onMounted(() => {
  void loadMonthEntries()
  void loadRecentEntries()
})

watch(visibleMonth, () => {
  void loadMonthEntries()
})
</script>

<template>
  <!-- Frame 01 — Dashboard (docs/example-journal-first.html) -->
  <div class="dashboard">
    <div class="app-header">
      <div class="app-title">mind<span class="title-dot">·</span>scribe</div>
      <div class="app-date">{{ headerDate }}</div>
    </div>

    <div class="calendar-card">
      <div class="calendar-month-row">
        <button class="month-nav" aria-label="Previous month" @click="changeMonth(-1)">‹</button>
        <div class="calendar-month">{{ monthLabel }}</div>
        <button class="month-nav" aria-label="Next month" @click="changeMonth(1)">›</button>
      </div>
      <div class="cal-grid">
        <div v-for="(name, index) in DAY_NAMES" :key="index" class="cal-dow">{{ name }}</div>
        <div v-for="(cell, index) in grid" :key="index" :class="cellClasses(cell)">
          {{ cellText(cell) }}
        </div>
      </div>
    </div>

    <p v-if="loadError" class="load-error" role="alert">{{ loadError }}</p>
    <p v-else-if="recentEntries.length === 0" class="empty-note">
      Nothing here yet. Tap + whenever you're ready.
    </p>

    <template v-if="recentEntries.length > 0">
      <div class="section-label">Recent</div>
      <div v-for="entry in recentEntries" :key="entry.id" class="entry-row">
        <div class="entry-mood" aria-hidden="true">{{ entry.moodEmoji || '·' }}</div>
        <div class="entry-body">
          <div class="entry-title">{{ deriveTitle(entry.content, entry.createdAt) }}</div>
          <div class="entry-snippet">{{ deriveSnippet(entry.content) }}</div>
          <div class="entry-date">{{ formatEntryTimestamp(entry.createdAt) }}</div>
        </div>
      </div>
    </template>

    <button class="fab" aria-label="New entry" @click="router.push('/entry/new')">+</button>
  </div>
</template>

<style scoped>
/* Mirrors the wireframe's 01 — Dashboard frame; tokens come from main.css. */

/* ---- Header ---- */
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

.title-dot {
  color: var(--accent);
}

.app-date {
  font-family: 'JetBrains Mono', monospace;
  font-size: 11px;
  color: var(--text-muted);
}

/* ---- Calendar ---- */
.calendar-card {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  padding: var(--space-4);
  margin-bottom: var(--space-4);
}

.calendar-month-row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  margin-bottom: var(--space-3);
}

.calendar-month {
  flex: 1;
  text-align: center;
  font-family: 'JetBrains Mono', monospace;
  font-size: 12px;
  color: var(--text-muted);
  letter-spacing: 0.06em;
  text-transform: uppercase;
}

/* W5 AC month nav — the wireframe doesn't show these, so keep them quiet. */
.month-nav {
  background: none;
  border: none;
  color: var(--text-muted);
  font-family: 'JetBrains Mono', monospace;
  font-size: 16px;
  line-height: 1;
  padding: 4px 10px;
  cursor: pointer;
}

.month-nav:hover {
  color: var(--accent);
}

.cal-grid {
  display: grid;
  grid-template-columns: repeat(7, 1fr);
  gap: 6px;
  text-align: center;
}

.cal-dow {
  font-family: 'JetBrains Mono', monospace;
  font-size: 10px;
  color: #55503f;
  padding-bottom: 4px;
}

.cal-day {
  aspect-ratio: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 13px;
  border-radius: 50%;
  color: var(--text-muted);
  position: relative;
}

.cal-day-blank {
  aspect-ratio: 1;
}

.cal-day.has-entry {
  color: var(--text);
}

.cal-day.has-entry::after {
  content: '';
  position: absolute;
  bottom: 3px;
  width: 4px;
  height: 4px;
  border-radius: 50%;
  background: var(--accent);
}

.cal-day.mood {
  font-size: 15px;
}

/* The emoji itself is the marker — no dot underneath it (per wireframe). */
.cal-day.mood::after {
  display: none;
}

.cal-day.today {
  background: var(--accent-soft);
  color: var(--accent);
  font-weight: 600;
}

/* ---- Empty state (plan W5 AC) ---- */
.empty-note {
  font-family: 'Fraunces', serif;
  font-size: 14px;
  color: var(--text-muted);
  text-align: center;
  padding: var(--space-3) var(--space-2);
  margin-bottom: var(--space-4);
}

.load-error {
  font-family: 'JetBrains Mono', monospace;
  font-size: 10.5px;
  color: var(--crisis);
  text-align: center;
  margin-bottom: var(--space-4);
}

/* ---- Recent ---- */
.section-label {
  font-family: 'JetBrains Mono', monospace;
  font-size: 11px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--text-muted);
  margin-bottom: var(--space-2);
}

.entry-row {
  display: flex;
  align-items: flex-start;
  gap: var(--space-3);
  padding: var(--space-3) 0;
  border-bottom: 1px solid var(--border);
}

.entry-row:last-child {
  border-bottom: none;
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

/* ---- FAB ---- */
.fab {
  position: fixed;
  /* Above the 76px tabbar + breathing room, per the wireframe. */
  bottom: 92px;
  right: var(--space-4);
  width: 58px;
  height: 58px;
  border-radius: 50%;
  background: var(--accent);
  color: #1a1408;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 26px;
  font-weight: 500;
  box-shadow: 0 0 0 0 rgba(227, 164, 76, 0.5);
  animation: fab-glow 2.6s ease-in-out infinite;
  border: none;
  cursor: pointer;
  z-index: 5;
}

@keyframes fab-glow {
  0%, 100% {
    box-shadow: 0 0 0 0 rgba(227, 164, 76, 0.35);
  }
  50% {
    box-shadow: 0 0 0 14px rgba(227, 164, 76, 0);
  }
}

@media (prefers-reduced-motion: reduce) {
  .fab {
    animation: none;
  }
}
</style>
