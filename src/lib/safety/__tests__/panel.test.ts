import { describe, expect, it } from 'vitest'
import { checkCrisisSignal } from '../crisis-check'
import { buildCrisisPanel, CRISIS_PANEL_HEADLINE } from '../panel'
import { CRISIS_RESOURCES } from '../resources'

describe('buildCrisisPanel (W6b) — crisis trip → panel content mapping', () => {
  it('maps a tripped check to a gentle card with the full resource list', () => {
    const matches = checkCrisisSignal('lately i just want to kill myself and i have no reason to live')

    expect(matches.length).toBeGreaterThan(0)
    const panel = buildCrisisPanel(matches)
    expect(panel).not.toBeNull()
    expect(panel?.headline).toBe(CRISIS_PANEL_HEADLINE)
    expect(panel?.resources).toEqual(CRISIS_RESOURCES)
    expect(panel?.resources.length).toBeGreaterThanOrEqual(3)
  })

  it('surfaces the US 988 lifeline first (the most reachable default)', () => {
    const panel = buildCrisisPanel(checkCrisisSignal('i want to die'))
    expect(panel?.resources[0]).toEqual(CRISIS_RESOURCES[0])
  })

  it('returns null when nothing tripped, so the view renders no card', () => {
    const matches = checkCrisisSignal('the depgraph thing finally clicked, what a relief')
    expect(matches).toEqual([])
    expect(buildCrisisPanel(matches)).toBeNull()
  })

  it('returns null for an empty result set (defensive, matches the check contract)', () => {
    expect(buildCrisisPanel([])).toBeNull()
  })

  it('honours the safeguard: an untripped hyperbole reading shows no card', () => {
    // The approved checker's "want to die laughing" guard — the panel must
    // stay silent when the check stays silent.
    expect(buildCrisisPanel(checkCrisisSignal('that joke made me want to die laughing'))).toBeNull()
  })
})