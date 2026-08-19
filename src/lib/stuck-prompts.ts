/**
 * Generic "stuck?" prompt pool (W6b; plan decision T8).
 *
 * A small pool of warm, non-clinical opening prompts shown in the stuck
 * aside card when the writer doesn't know what to write. Rotation is
 * deterministic: the seed (entry count at session start, decision T8)
 * picks the first prompt, and "give me another" walks the pool without
 * repeating any prompt until the whole pool has been shown this session.
 *
 * W9: this module stays as the generic fallback for new / thin-history
 * journals. Theme-based prompts ("From your recent entries") live in
 * stuck-themes.ts, which reuses the pool-agnostic rotation core below.
 *
 * Public API (startStuckPromptCycle / currentStuckPrompt /
 * advanceStuckPrompt) is unchanged — the generic behavior W6b shipped is
 * byte-for-byte the same; the core functions are just parameterized so
 * the themed tier can rotate its own small template pool identically.
 */
export const GENERIC_STUCK_PROMPTS: readonly string[] = [
  'Anything stand out about today, even something small?',
  'What has been taking up space in your head lately?',
  'If the last few days had a title, what would it be?',
  'What are you hoping for, even a little?',
  'What did you notice today that you almost missed?',
  'Where does your mind go when it wanders right now?',
]

/** Rotation state for one writing session (one entry). */
export interface StuckPromptState {
  /** Pool index of the prompt currently shown. */
  cursor: number
  /** Pool indices already shown this session, oldest first. */
  shown: number[]
}

/**
 * Rotation core (W9): starts a session's rotation over a pool of
 * `poolSize` items, seeded deterministically. The seed (typically the
 * entry count, decision T8) selects the first item so consecutive
 * entries open on different items and re-opening the app is stable.
 */
export function startPromptCycle(seed: number, poolSize: number): StuckPromptState {
  if (poolSize <= 0) {
    throw new Error('startPromptCycle: poolSize must be positive')
  }
  const first = ((Math.trunc(seed) % poolSize) + poolSize) % poolSize
  return { cursor: first, shown: [first] }
}

/** The item currently shown by `state` within `pool`. */
export function currentPrompt(state: StuckPromptState, pool: readonly string[]): string {
  return pool[state.cursor]
}

/**
 * Advances to the next unseen item ("Not this one"). Never repeats an
 * item before the whole pool has been shown; after the pool is
 * exhausted it wraps and may repeat, which is fine for a long session.
 */
export function advancePrompt(state: StuckPromptState, poolSize: number): StuckPromptState {
  const stillUnseen = state.shown.length < poolSize
  let next = (state.cursor + 1) % poolSize
  while (stillUnseen && state.shown.includes(next)) {
    next = (next + 1) % poolSize
  }
  return { cursor: next, shown: [...state.shown, next] }
}

/** Starts a session's cycle over the generic pool (W6b public API — unchanged). */
export function startStuckPromptCycle(seed: number): StuckPromptState {
  return startPromptCycle(seed, GENERIC_STUCK_PROMPTS.length)
}

/** The generic prompt currently shown by `state` (W6b public API — unchanged). */
export function currentStuckPrompt(state: StuckPromptState): string {
  return currentPrompt(state, GENERIC_STUCK_PROMPTS)
}

/** Advances over the generic pool (W6b public API — unchanged). */
export function advanceStuckPrompt(state: StuckPromptState): StuckPromptState {
  return advancePrompt(state, GENERIC_STUCK_PROMPTS.length)
}