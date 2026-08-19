/**
 * W9 — themed "stuck?" prompts (tier 1 of the stuck path).
 *
 * When the rolling summary (W11) offers a meaningful theme, the stuck
 * aside card is grounded in it: `pickPromptTheme` (themes.ts) selects the
 * most recent / recurring theme deterministically, and a small template
 * pool turns its topic into a warm, open question. When no theme is
 * selectable (new user / thin history) the flow falls back to the generic
 * pool (tier 2, stuck-prompts.ts) unchanged. The card itself always stays
 * a light aside — the dominant textarea is never blocked (flow.md).
 *
 * PRODUCT DECISION — template-phrased, not model-phrased: the model's job
 * in this feature (theme extraction) is already done; the summary is
 * structured data, not prose. Phrasing from a template is instant, fully
 * offline and model-free (a stuck prompt must never trigger a model
 * download), and it matches the PRD's own example shape ("has anything
 * shifted with X?"). Trade-off: templates can't react to a theme's valence
 * — an evenly hedged, non-presumptuous register ("sounded like…",
 * "anything shifted?") keeps every template safe regardless of the theme.
 */
import {
  advancePrompt,
  currentPrompt,
  GENERIC_STUCK_PROMPTS,
  startPromptCycle,
  type StuckPromptState,
} from './stuck-prompts'
import { pickPromptTheme, type Theme } from './model/themes'

/**
 * Warm, open, grounded templates. The topic always sits mid-sentence
 * (lowercased — see normalizeTopicForPrompt) and every template is a
 * genuine open question that ends in "?". None evaluate, diagnose, or
 * advise: no "how did you feel about", no restructuring vocabulary, no
 * recurrence claims that would break for a single-mention theme (the
 * PRD non-CBT guardrails).
 */
const THEMED_STUCK_TEMPLATES: readonly ((topic: string) => string)[] = [
  (topic) => `You mentioned ${topic} recently — has anything shifted with it?`,
  (topic) => `It sounded like ${topic} has been on your mind — what's it been like since?`,
  (topic) => `Your recent entries touched on ${topic} — is there anything more you'd want to write about it?`,
]

/** A selectable theme + its phrased questions in deterministic rotation order. */
export interface ThemedPromptSet {
  theme: Theme
  prompts: readonly string[]
}

/** Which pool the current stuck card is showing (W9 tier). */
export type StuckPromptTier = 'themed' | 'generic'

/**
 * One writing session's stuck-prompt flow. Lives in tier 1 (themed) while
 * a themed rotation remains, then falls through to tier 2 (generic),
 * seeded by the entry count (decision T8) — the user can keep cycling or
 * dismiss with "Just a plain page"; there is never a dead end.
 */
export interface StuckPromptFlow {
  tier: StuckPromptTier
  /** Phrased themed questions in rotation order; empty once tier 2 is reached. */
  themedPrompts: readonly string[]
  /** Rotation within the ACTIVE tier's pool. */
  rotation: StuckPromptState
  /** Entry-count seed (T8) the generic pool is (re)seeded from on fall-through. */
  entrySeed: number
}

/**
 * Phrases the selected theme — the most recent / recurring one per
 * `pickPromptTheme` (themes.ts) — into a rotation of open questions.
 * Returns null when no theme is selectable (no meaningful summary).
 *
 * `themeHash` rotates the TEMPLATE starting point so consecutive entries
 * (same theme, different entry count) don't open on the same phrasing —
 * the caller passes the same entry-count seed it uses for the generic
 * pool, preserving the per-entry non-repeat contract (T8).
 */
export function buildThemedStuckPrompts(
  themes: readonly Theme[],
  themeHash = 0,
): ThemedPromptSet | null {
  const theme = pickPromptTheme(themes)
  if (!theme) return null
  const topic = normalizeTopicForPrompt(theme.topic)
  if (topic.length === 0) return null
  return { theme, prompts: rotateTemplates(topic, themeHash) }
}

/** Starts the two-tier flow; an empty themed set starts straight in tier 2. */
export function startStuckPromptFlow(
  themedPrompts: readonly string[],
  entrySeed: number,
): StuckPromptFlow {
  if (themedPrompts.length === 0) {
    return {
      tier: 'generic',
      themedPrompts: [],
      rotation: startPromptCycle(entrySeed, GENERIC_STUCK_PROMPTS.length),
      entrySeed,
    }
  }
  return {
    tier: 'themed',
    themedPrompts,
    // buildThemedStuckPrompts already rotated the ORDER by themeHash —
    // the themed rotation itself always starts at the first question.
    rotation: startPromptCycle(0, themedPrompts.length),
    entrySeed,
  }
}

/** The question currently shown by `flow` (whichever tier is active). */
export function currentStuckPromptFlow(flow: StuckPromptFlow): string {
  if (flow.tier === 'themed') return currentPrompt(flow.rotation, flow.themedPrompts)
  return currentPrompt(flow.rotation, GENERIC_STUCK_PROMPTS)
}

/**
 * "Not this one" — advance to the next question. Within tier 1 it walks
 * the themed questions without repeating any; once every themed question
 * has been shown it falls through to tier 2 (the generic pool, seeded by
 * the entry count T8). Inside tier 2 it rotates the generic pool, which
 * wraps and may repeat only after the whole pool has been shown.
 */
export function advanceStuckPromptFlow(flow: StuckPromptFlow): StuckPromptFlow {
  if (flow.tier === 'generic') {
    return { ...flow, rotation: advancePrompt(flow.rotation, GENERIC_STUCK_PROMPTS.length) }
  }
  const themedExhausted = flow.rotation.shown.length >= flow.themedPrompts.length
  if (themedExhausted) {
    return {
      tier: 'generic',
      themedPrompts: [],
      rotation: startPromptCycle(flow.entrySeed, GENERIC_STUCK_PROMPTS.length),
      entrySeed: flow.entrySeed,
    }
  }
  return { ...flow, rotation: advancePrompt(flow.rotation, flow.themedPrompts.length) }
}

/**
 * Topics come from the model's theme phrases, so casing and punctuation
 * are noisy. Normalize for mid-sentence insertion: trim, collapse internal
 * whitespace, strip trailing sentence punctuation, and lowercase — full
 * lowercase keeps "River Walk" or "WORK!" from reading as double capitals
 * mid-sentence. Trade-off: acronyms ("AI" → "ai") lose their caps; there
 * is no reliable way to distinguish an acronym from a proper noun, and
 * consistent lowercase reads cleaner in a warm journaling prompt.
 */
function normalizeTopicForPrompt(topic: string): string {
  const collapsed = topic.trim().replace(/\s+/g, ' ')
  const withoutTrailingPunctuation = collapsed.replace(/[.!?;:,—–-]+$/, '')
  return withoutTrailingPunctuation.toLowerCase()
}

/** All templates, in template order, rotated to start at `themeHash % pool`. */
function rotateTemplates(topic: string, themeHash: number): readonly string[] {
  const rotation = startPromptCycle(themeHash, THEMED_STUCK_TEMPLATES.length)
  return THEMED_STUCK_TEMPLATES.map((_, index) => {
    const templateIndex = (rotation.cursor + index) % THEMED_STUCK_TEMPLATES.length
    return THEMED_STUCK_TEMPLATES[templateIndex](topic)
  })
}