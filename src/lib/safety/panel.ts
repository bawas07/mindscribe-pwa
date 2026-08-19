/**
 * Crisis resource panel mapping (W6b).
 *
 * The deterministic safety check itself lives in crisis-check.ts (approved,
 * unchanged). This module owns the tiny mapping from a check result to what
 * the UI renders: a muted, non-clinical card listing CRISIS_RESOURCES.
 *
 * Non-blocking by construction: the panel is rendered AFTER the entry has
 * been saved, it never gates or alters the save, and it only appears when
 * the check actually tripped (null otherwise).
 */
import type { CrisisMatch } from './crisis-check'
import { CRISIS_RESOURCES, type CrisisResource } from './resources'

/** Gentle lead-in above the resource list — warm, never clinical. */
export const CRISIS_PANEL_HEADLINE = 'We noticed something — here is support'

export interface CrisisPanel {
  headline: string
  resources: CrisisResource[]
}

/**
 * Maps a check result to panel content. Returns null when nothing tripped,
 * so views can render the card only when it has actual content.
 */
export function buildCrisisPanel(matches: CrisisMatch[]): CrisisPanel | null {
  if (matches.length === 0) return null
  return { headline: CRISIS_PANEL_HEADLINE, resources: CRISIS_RESOURCES }
}