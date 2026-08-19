import { describe, expect, it } from 'vitest'
import {
  buildMonthGrid,
  formatDateTitle,
  formatEntryTimestamp,
  formatHeaderDate,
  formatMonthLabel,
} from '../calendar'

/** A Date safely outside the months under test, so isToday stays false there. */
const OTHER_MONTH = new Date(2026, 6, 1, 12, 0, 0)

describe('buildMonthGrid (W5 calendar)', () => {
  it('returns 42 cells with Sunday-start leading blanks (August 2026 starts on a Saturday)', () => {
    const grid = buildMonthGrid(2026, 7, OTHER_MONTH)

    expect(grid).toHaveLength(42)
    expect(grid.findIndex((cell) => cell.inMonth)).toBe(6)
    expect(grid[5].day).toBeNull()
    expect(grid[5].inMonth).toBe(false)
    expect(grid[6].day).toBe(1)
    expect(grid[6].inMonth).toBe(true)
  })

  it('honours the first-weekday offset for other months (April 2026 starts on a Wednesday)', () => {
    const grid = buildMonthGrid(2026, 3, OTHER_MONTH)

    expect(grid.findIndex((cell) => cell.inMonth)).toBe(3)
  })

  it('covers a 31-day month completely', () => {
    const grid = buildMonthGrid(2026, 0, OTHER_MONTH)

    const inMonth = grid.filter((cell) => cell.inMonth)
    expect(inMonth).toHaveLength(31)
    expect(inMonth[0].day).toBe(1)
    expect(inMonth[30].day).toBe(31)
  })

  it('covers a 30-day month completely', () => {
    const grid = buildMonthGrid(2026, 3, OTHER_MONTH)

    expect(grid.filter((cell) => cell.inMonth)).toHaveLength(30)
  })

  it('covers a non-leap February (2025: 28 days, starts on a Saturday)', () => {
    const grid = buildMonthGrid(2025, 1, OTHER_MONTH)

    expect(grid.findIndex((cell) => cell.inMonth)).toBe(6)
    expect(grid.filter((cell) => cell.inMonth)).toHaveLength(28)
  })

  it('covers a leap-year February (2024: 29 days, starts on a Thursday)', () => {
    const grid = buildMonthGrid(2024, 1, OTHER_MONTH)

    expect(grid.findIndex((cell) => cell.inMonth)).toBe(4)
    expect(grid.filter((cell) => cell.inMonth)).toHaveLength(29)
  })

  it('marks exactly today with isToday', () => {
    const today = new Date(2026, 7, 19, 12, 0, 0)
    const grid = buildMonthGrid(2026, 7, today)

    const todaysCells = grid.filter((cell) => cell.isToday)
    expect(todaysCells).toHaveLength(1)
    expect(todaysCells[0].day).toBe(19)
    expect(todaysCells[0].inMonth).toBe(true)
  })

  it('never highlights today when viewing another month', () => {
    const today = new Date(2026, 7, 19, 12, 0, 0)
    const grid = buildMonthGrid(2026, 8, today)

    expect(grid.some((cell) => cell.isToday)).toBe(false)
  })
})

describe('date formatters', () => {
  it('formats the header date like the wireframe (19 AUG 2026)', () => {
    expect(formatHeaderDate(new Date(2026, 7, 19))).toBe('19 AUG 2026')
  })

  it('formats the calendar month label', () => {
    expect(formatMonthLabel(2026, 7)).toBe('August 2026')
    expect(formatMonthLabel(2025, 0)).toBe('January 2025')
  })

  it('formats entry timestamps like the wireframe (AUG 17 · 08:42)', () => {
    const createdAt = new Date(2026, 7, 17, 8, 42).toISOString()
    expect(formatEntryTimestamp(createdAt)).toBe('AUG 17 · 08:42')
  })

  it('formats the date-title fallback (17 August)', () => {
    const createdAt = new Date(2026, 7, 17, 8, 42).toISOString()
    expect(formatDateTitle(createdAt)).toBe('17 August')
  })
})
