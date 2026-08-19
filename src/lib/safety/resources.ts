/**
 * Default crisis-resource list surfaced by the W6b resource panel when the
 * deterministic safety check trips.
 *
 * ⚠ HUMAN REVIEW / LOCALIZATION REQUIRED before M1 ships: these numbers are
 * intentionally few and US/UK-leaning. They must be verified for each target
 * market before release (plan milestone-1.md open question "Safety resource
 * content"; T4/R4 human sign-off). The list is data the UI displays — keep
 * the copy gentle and consistent with the app's warm, non-clinical voice
 * ("a quiet place to write … it will quietly point you to resources that can
 * actually help"), never clinical or alarming.
 */

export interface CrisisResource {
  /** Stable unique id, used by the UI to dedupe / persist dismissal. */
  id: string
  /** Resource name as shown in the panel. */
  name: string
  /** Dial string / short code. Empty ('' ) only for directory-style entries. */
  phone: string
  /** One-line, warm, non-clinical description of what to expect. */
  note: string
}

/** Default resources the W6b panel shows. Stored as data, not copy-run code. */
export const CRISIS_RESOURCES: CrisisResource[] = [
  {
    id: 'us-988',
    name: '988 Suicide & Crisis Lifeline',
    phone: '988',
    note: 'United States — call or text 988. A real person answers, free and confidential, any time.',
  },
  {
    id: 'us-crisis-text-line',
    name: 'Crisis Text Line',
    phone: '741741',
    note: 'United States — text HOME to 741741. Free, confidential text support from real people, 24/7.',
  },
  {
    id: 'uk-ie-samaritans',
    name: 'Samaritans',
    phone: '116 123',
    note: 'UK & Ireland — call 116 123 for free. Someone will listen, 24/7, no judgment.',
  },
  {
    id: 'int-findahelpline',
    name: 'Find a Helpline',
    phone: '',
    note: 'Everywhere — a directory of local helplines by country, so support exists close to wherever you are.',
  },
]

/** Convenience lookup for the UI; returns undefined for a missing id. */
export function getCrisisResource(id: string): CrisisResource | undefined {
  return CRISIS_RESOURCES.find((resource) => resource.id === id)
}
