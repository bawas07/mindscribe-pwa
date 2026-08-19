/**
 * Pure calendar-grid and date-formatting helpers for the dashboard (W5).
 *
 * Everything here is deterministic and local-timezone based: the
 * calendar is a personal, local view, so month grids and day markers
 * use the user's own timezone rather than UTC.
 *
 * No IO, no dependencies — unit-testable and reusable by W7 (history
 * lists reuse formatEntryTimestamp / formatDateTitle).
 */

export interface CalendarCell {
  /** Day of month for in-month cells; null for leading/trailing blanks. */
  day: number | null
  inMonth: boolean
  isToday: boolean
}

/** Sunday-start column headers, in the wireframe's order (S M T W T F S). */
export const DAY_NAMES = ['S', 'M', 'T', 'W', 'T', 'F', 'S'] as const

const GRID_CELL_COUNT = 42
const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
] as const
export const MONTH_ABBREVIATIONS = [
  'JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN',
  'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC',
] as const

/**
 * Builds the 42-cell calendar grid for a month (month is 0-based).
 * Leading blanks come from the month's first weekday on a Sunday-start
 * grid, per the wireframe's cal-dow order. `today` is injectable so
 * tests can pin which day gets the isToday highlight.
 */
export function buildMonthGrid(year: number, month: number, today: Date = new Date()): CalendarCell[] {
  const daysInMonth = new Date(year, month + 1, 0).getDate()
  const leadingBlanks = new Date(year, month, 1).getDay()
  const isCurrentMonth = today.getFullYear() === year && today.getMonth() === month

  return Array.from({ length: GRID_CELL_COUNT }, (_, index) => {
    const dayOfMonth = index - leadingBlanks + 1
    const inMonth = dayOfMonth >= 1 && dayOfMonth <= daysInMonth
    return {
      day: inMonth ? dayOfMonth : null,
      inMonth,
      isToday: inMonth && isCurrentMonth && dayOfMonth === today.getDate(),
    }
  })
}

/** Calendar card label, e.g. "August 2026". */
export function formatMonthLabel(year: number, month: number): string {
  return `${MONTH_NAMES[month]} ${year}`
}

/** App-header date, e.g. "19 AUG 2026" (wireframe's mono date). */
export function formatHeaderDate(date: Date): string {
  const day = String(date.getDate()).padStart(2, '0')
  return `${day} ${MONTH_ABBREVIATIONS[date.getMonth()]} ${date.getFullYear()}`
}

/** Entry-row timestamp, e.g. "AUG 17 · 08:42" (local time). */
export function formatEntryTimestamp(createdAt: string): string {
  const date = new Date(createdAt)
  const day = String(date.getDate()).padStart(2, '0')
  const hours = String(date.getHours()).padStart(2, '0')
  const minutes = String(date.getMinutes()).padStart(2, '0')
  return `${MONTH_ABBREVIATIONS[date.getMonth()]} ${day} · ${hours}:${minutes}`
}

/** Date-based title fallback, e.g. "17 August" (wireframe's history rows). */
export function formatDateTitle(createdAt: string): string {
  const date = new Date(createdAt)
  return `${date.getDate()} ${MONTH_NAMES[date.getMonth()]}`
}
