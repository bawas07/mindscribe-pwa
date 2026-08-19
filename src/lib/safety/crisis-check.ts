/**
 * Deterministic crisis-signal check (W6a).
 *
 * A pure, rule-based gate that runs on every entry save, completely
 * independently of the model flow. It is deliberately *dumb and reliable*:
 * no probabilistic inference, no clinical scoring — just phrase matching on
 * normalised, lowercased text, always deterministic.
 *
 * This is NOT a clinical detector and is not a substitute for one. The PRD
 * ("Safety check (deterministic, not model-based)") is explicit: small local
 * models and simple keyword checks are best-effort nudges, not diagnostic
 * tools. Its job is limited to: if tripped, the UI surfaces crisis resources
 * (W6b). It never blocks or alters the journaling flow.
 *
 * ── Grounding (the phrase list is not off-the-cuff) ─────────────────────────
 * The phrase set below is curated from publicly documented crisis-language
 * signal families. Primary sources:
 * - SafeChat "International Chat Safety Protocol" (rob-e-graham/safechat):
 *   an open-source, regex-based, fully-local signal pack that distils the
 *   C-SSRS / CLPsych / Reddit-C-SSRS families and ships with false-positive
 *   context guards. We drew signal families and structural ideas from it
 *   (not a wholesale copy) and cross-checked our own phrases against it.
 * - C-SSRS — Columbia-Suicide Severity Rating Scale (Posner et al. 2011):
 *   wish-to-be-dead, active ideation, method, intent, and plan language.
 * - CLPsych shared-task risk tiers (Zirikly et al. 2019) and Reddit C-SSRS
 *   (Gaur et al. 2019): severity-linked phrasing for suicide-risk language.
 * - NOPE "How to Detect Suicidal Ideation in Your Chatbot" (nope.net):
 *   informed the false-positive/hyperbole stance — keyword filters are a
 *   fast first pass with a high benign-noise rate, and false alarms carry
 *   real harm (eroded trust, unnecessary wellness checks). We treat the
 *   check as exactly that: a fast, local, non-blocking nudge.
 * - In-repo: PRD "Safety check" section, plan-milestone-1.md T4 / risk R4
 *   (dedicated research + human review sign-off before ship).
 *
 * ── False-positive stance ───────────────────────────────────────────────────
 * We err toward NOT tripping on benign text (see samples in the docstring
 * of `CRISIS_RULES` and their guards). Design rules:
 * 1. Prefer multi-word, self-directed phrases over lone single words.
 *    "kill the process", "end it in overtime", "cut my hair", "hurt my
 *    ankle" therefore do not match anything.
 * 2. A few lone high-signal words ("suicide", "overdose", "bleeding",
 *    "disappear") are allowed but carry local-context guard filters that
 *    suppress obviously-benign readings (prevention/awareness/sports
 *    idioms, non-drug "overdose on coffee", economic "bleeding").
 * 3. A narrow hyperbole guard suppresses dark-joke / denial-of-hyperbole
 *    readings of "want to die" / "kill myself" ("i want to die laughing",
 *    "kms lol", "just kidding"). Negation is handled explicitly: a negated
 *    joke/kidding marker ("not a joke", "not just kidding") asserts the
 *    intent is real and never suppresses, and an explicitly negated
 *    first-person phrase ("i don't want to die") is not tripped. This is done
 *    with a JS-side negation probe — there are NO regex lookbehinds anywhere
 *    in this module, because iOS Safari rejects variable-length lookbehind
 *    as a load-time SyntaxError and Safari is this PWA's primary target.
 *
 * Deliberately conservative: ~30 phrase cores, all with a genuine
 * crisis-relevant reading. This reliably catches explicit, self-directed
 * language but WILL miss many indirect/implicit cases ("made peace with
 * everything", "who'll feed my cat after Friday"). That is an intentional
 * scope decision for M1 — a gentle nudge, not a clinical triage tool.
 *
 * ⚠ HUMAN REVIEW REQUIRED before W6b wires this in (plan T4 / risk R4):
 * the exact phrase set and guards must be reviewed by someone with
 * crisis-line or mental-health expertise, and localized for target markets.
 */

export interface CrisisMatch {
  /** The phrase that tripped, as a readable label (lowercase), e.g. "kill myself". */
  pattern: string
  /** Character index of the match in the *normalised* input text. */
  matchedAt: number
}

interface CrisisRule {
  /** Human-readable label surfaced as `pattern` in a match. */
  label: string
  /** Regex searched over the normalised (lowercased, trimmed) text. No /g flag. */
  pattern: RegExp
  /**
   * Optional local-context disambiguation: if this regex matches within
   * `guardWindow` characters of the hit, the hit is suppressed. Checking a
   * window (not the whole text) keeps guards tight to the phrase.
   */
  guard?: RegExp
  /** Half-width of the guard window in characters. */
  guardWindow?: number
  /**
   * Mark this guard as negatable hyperbole (jokes/kidding): a guard hit that
   * is itself negated ("not a joke", "not just kidding", "not just kidding")
   * is an assertion the intent is real and must NOT suppress. Uses the
   * Safari-safe `isNegatedAhead` probe.
   */
  guardNegationSensitive?: boolean
  /**
   * A first-person negator immediately before the phrase ("i don't want to
   * die", "i won't kill myself", "i didn't cut myself") suppresses the trip.
   * Trade-off: a genuine sentence that literally negates ("i don't want to
   * die looking like this") is missed — accepted, flagged for T4 sign-off.
   */
  negationSuppresses?: boolean
}

const DEFAULT_GUARD_WINDOW = 70
/** Wide window for lone-word patterns whose benign reading lives a clause away. */
const WIDE_GUARD_WINDOW = 100

/** Dark-joke / hyperbole markers we refuse to let a phrase trip alongside.
 * The regexes carry NO lookbehinds (Safari-safe); negation of a marker
 * ("not a joke", "not just kidding") is detected by the `isNegatedAhead`
 * probe inside `guardTrips` — a negated marker is an assertion the intent is
 * real and is not a suppressor. Kidding needs a just/only/am/was qualifier. */
const HYPERBOLE_MARKERS: RegExp = new RegExp(
  [
    '\\b(lol|lmao|lmfao|rofl|hahaha|hehe|haha|jk)\\b', // tongue-in-cheek shorthand
    '(?:just|only|am|was)\\s+kidding',
    '(?:just|only)\\s+(?:a\\s+|an\\s+)?jok\\w*',
    'a\\s+jok\\w*',
    'dark\\s+jok\\w*',
    '💀|🤣',
  ].join('|'),
)

/**
 * Guard for the "want to die" rule ONLY. Stricter than HYPERBOLE_MARKERS:
 * the laugh markers are idiom-tight so mere proximity of "laughing" does not
 * suppress a real signal ("everyone's laughing at me, i want to die"), and
 * the dropped lol/lmao/rofl/hehe/haha family means only clear disavowal and
 * laughter-idioms suppress. "my grandma is dying and i want to die" and
 * "everyone's laughing at me, i want to die" both still trip.
 */
const WANT_TO_DIE_GUARD: RegExp = new RegExp(
  [
    '\\bjk\\b',
    '(?:just|only|am|was)\\s+kidding',
    '(?:just|only)\\s+(?:a\\s+|an\\s+)?jok\\w*',
    'a\\s+jok\\w*',
    'dark\\s+jok\\w*',
    // Laughter-IDIOM variants only ("i want to die laughing", "laughing my
    // head off"); bare "laugh/laughing" proximity must not suppress.
    '\\b(laughing (my|his|her|their) (ass|head|face|arse) off|(die|dying) laughing|laughing so hard|hahaha)\\b',
    '💀|🤣',
  ].join('|'),
)

/**
 * The curated phrase set. Order is the source-order they are reported in
 * when multiple matches share an index; matches are otherwise ordered by
 * `matchedAt`. See module docstring for grounding and the false-positive
 * stance behind the entries and guards below.
 */
const CRISIS_RULES: CrisisRule[] = [
  // ── Explicit suicidal intent ──────────────────────────────────────────────
  {
    label: 'suicide',
    pattern: /\bsuicid[a-z]*/,
    // Suppress educational / prevention / third-party / idiom readings of
    // the bare word. "suicidal thoughts" trips (no guard word nearby).
    guard:
      /\b(prevention|awareness|hotline|helpline|lifeline|crisis[- ]?line|squeeze|bunt|mission|doors?|stats?|statistics|stigma|campaign|memorial|survivors?|rates?|squad|vest|bomb|bombing|attack)\b/,
    guardWindow: WIDE_GUARD_WINDOW,
  },
  {
    label: 'kill myself',
    pattern: /\bkill(ing)? myself\b/,
    guard: HYPERBOLE_MARKERS,
    guardNegationSensitive: true,
    negationSuppresses: true,
  },
  {
    label: 'end my life',
    pattern: /\bend(ing)? (my|this|her|his|their) life\b/,
    negationSuppresses: true,
  },
  {
    label: 'end it all',
    pattern: /\bend(ing)? it all\b/,
    negationSuppresses: true,
  },
  {
    label: 'take my life',
    pattern: /\btake my (own )?life\b/,
    negationSuppresses: true,
  },
  {
    label: 'want to die',
    pattern: /\b(?:want(?:ing|ed)?|wanna|wants?) (?:to )?die\b/,
    guard: WANT_TO_DIE_GUARD,
    guardNegationSensitive: true,
    negationSuppresses: true,
  },
  {
    label: 'wish i was dead',
    pattern: /\bwish(ed|ing)? i (was|were) dead\b/,
  },
  {
    label: 'better off dead',
    pattern: /\bbetter off dead\b/,
  },
  {
    label: 'no reason to live',
    pattern: /\bno reason (to live|for living|to keep living|to go on)\b/,
  },
  {
    label: 'nothing to live for',
    pattern: /\bnothing (left )?(to live for|worth living for)\b/,
  },
  {
    label: 'not worth living',
    pattern: /\b(isn'?t|is not|not) worth (living|living like this|being alive)\b/,
    // True-place complaints only: "here"/"there" or "in <place>" (apartment, city,
    // world…). "at all" and "with this pain" are genuine and stay trips.
    guard: /\b(here|there)\b|\bin (the |this |my |their |a )?(city|town|apartment|house|place|world|country|neighbourhood|neighborhood)\b/,
  },
  {
    label: 'ready to die',
    pattern: /\bready to (die|leave (this world|everyone)|end it)\b/,
  },

  // ── Self-harm ─────────────────────────────────────────────────────────────
  {
    label: 'cut myself',
    pattern: /\bcut(ting)? (myself|my (wrists?|arms?|thighs?))\b/,
    // "cut my hair", "cut myself shaving", "cut myself on glass / a slice of cake".
    // Bare "glass" is NOT enough: "cut my wrists with glass" is a crisis
    // method, so only the benign object-cut readings ("on glass", "a shard
    // of glass") guard.
    guard:
      /\b(shav\w*|paper|scissors|slice|slicing|cake|cakes|baguette|bread|cheese|kitchen|cooking|chopping|food|vegetable|onion|garlic|tomato|nails?|hair|accidentally|accident)\b|on (a |the )?glass\b|a (chunk|shard|piece) of glass\b/,
    negationSuppresses: true,
  },
  {
    label: 'hurt myself',
    pattern: /\bhurt(ing)? myself\b/,
    // Physical-injury contexts: "hurt myself at the gym / playing football / falling over".
    guard:
      /\b(gym|sport|football|soccer|basketball|baseball|volleyball|hockey|rugby|playing|running|kitchen|cooking|gardening|shav\w*|fall|fell|accidental|ankle|knee|back|neck|shoulder|wrist|elbow|finger|toe|stubbed|tripped|bumped)\b/,
    negationSuppresses: true,
  },
  {
    label: 'self-harm',
    pattern: /\bself[- ]?harm(ed|ing)?\b/,
  },
  {
    label: 'overdose',
    pattern: /\boverdos(e|ed|ing|es)\b/,
    // "overdosed on coffee/the fandom" — benign ingestible hyperbole.
    guard: /\bon (coffee|caffeine|sugar|chocolate|candy|fun|aww|cuteness|information|data|content|news|memes|hype|joy)\b/,
  },
  {
    label: 'hang myself',
    pattern: /\b(hang|hanging|hanged) myself\b/,
  },
  {
    label: 'shoot myself',
    pattern: /\bshoot(ing)? myself\b/,
    // The self-sabotage idiom: "shoot myself in the foot" is not a crisis signal.
    guard: /\bin the (foot|knee)\b/,
  },
  {
    label: 'slit my wrists',
    pattern: /\bslit(ting)? my (wrists?|throat)\b/,
  },
  {
    label: 'jump off a bridge',
    pattern: /\bjump(ed|ing)? (off|from) (a |the )?(bridge|building|roof|cliff)\b/,
    // Recreation readings: "jumped off the bridge to swim / for fun with friends".
    // Trade-off: a genuine "jumped off the river bridge into the water" sentence
    // that mentions swimming could be suppressed at the edges — flagged for the
    // human sign-off to weigh.
    guard: /\b(swim(ming)?|dive|diving)\b|(for fun|with friends)/,
  },
  {
    label: 'jump in front of traffic',
    pattern: /\bjump(ed|ing)? in front of (a |the )?(train|car|bus|truck)\b/,
  },
  {
    label: 'bleeding out',
    pattern: /\b(bleed(ing)? out|bled out)\b/,
    // "the market / company / colour is bleeding out".
    guard:
      /\b(economy|market|stocks?|company|business|budget|funds?|money|revenue|color|colour|dye|ink|paint|rust)\b/,
  },

  // ── Passive / preparatory (the strongest, most self-directed) ─────────────
  {
    label: 'nobody would miss me',
    // Allows an ever token and a one/two-token place-style qualifier
    // ("at all", "in the world", "out there", "anywhere") between the
    // subject and the verb, while STILL requiring the self-anchor
    // (me/us/him/her/them) or an if/when clause — that requirement is what
    // keeps "nobody misses the old site" and "no one will notice my haircut"
    // inert. Uses \s+ at the subject boundary and \s* between optional
    // middle groups (normalised text has single spaces).
    pattern:
      /\b(nobody|no one|no-one)\s+(at all|out there|anywhere|in (the )?(world|universe))?\s*(would|will|do|does|ever|even)?\s*(even|ever)?\s*(miss|cares?|notices?)( (me|us|him|her|them)( (if|when))?| (if|when))\b/,
  },
  {
    label: 'better off without me',
    pattern: /\bbetter off without me\b/,
  },
  {
    label: 'done with life',
    pattern: /\bdone with (life|living)\b/,
  },
  {
    label: 'given up on life',
    pattern: /\bgiv(en|ing)? up on (life|living)\b/,
  },
  {
    label: 'end the pain',
    pattern: /\b(end|stop) (my|the) (pain|suffering)\b/,
  },
  {
    label: 'goodbye note',
    pattern: /\b(suicide|farewell|goodbye) (note|letter)s?\b/,
    // Benign-leaving contexts only: "when i quit" must include the actual
    // leaving verb, so "a suicide note when i was at my lowest" still trips.
    guard:
      /\b(when (i|she|he|they) (quit|left|leave|retire|retired)|retirement|resignation|to the (team|company|job|class|school))\b/,
  },
  {
    label: 'want to disappear',
    pattern: /\bwant(ed|ing)? to disappear\b/,
    // "I want to disappear from Instagram" vs "I want to disappear forever".
    guard:
      /\b(from|off) (social media|instagram|facebook|twitter|tiktok|snapchat|reddit|the internet|online|town|work|the map)\b|magic trick/,
  },
  {
    label: "don't want to live",
    pattern: /\b(do not|don'?t) want to (live|be alive)\b/,
    // Suppress only on concrete places / persons, never on abstract reasons:
    // "don't want to live because everything hurts" and "with this pain" are
    // genuine signals and must trip.
    guard:
      /\b(in|here|there|near|where)\b|with (my|his|her|their|the) (parents?|family|roommates?|landlord|friends?|partner)\b/,
  },
  {
    label: "don't want to wake up",
    pattern: /\b(don'?t|do not) want to wake up\b/,
    // Schedule grumbles ("at 6am", "for work", "in the morning") are benign;
    // bare "don't want to wake up" trips.
    guard: /\bat \d|for (work|school)|(in|at) (the )?(morning|evening|afternoon|dawn|night)|at o'?clock\b/,
  },
  {
    label: "can't go on",
    pattern: /\b(can'?t|cannot|can not) (go on|carry on|keep going)\b/,
    // "can't go on this road trip / hike / to the gym" vs "I can't go on".
    // No further/farther here: "can't go on any further" is the exhausted
    // crisis phrasing and must trip.
    guard:
      /\b(trip|hike|drive|journey|ride|road|game|match|meeting|workout|gym\b|class|shift|show|episode|route)\b/,
  },
]

/**
 * Light, cheap normalisation shared by all matchers. This is the whole
 * "typo-resistant where cheap" promise: case folding, whitespace collapse,
 * smart-quote folding, and the one ultra-common text-speak token "kms".
 * Deliberately no leet-speak / misspelling engine — that is beyond the
 * "where cheap" scope and would risk over-matching.
 */
/** True when a "kms" token at `offset` is distance shorthand (digit before it).
 * Safari-safe replacement for what would be a variable-length lookbehind. */
function isDistanceShorthand(text: string, offset: number): boolean {
  return /\d[\s.,]?\s*$/.test(text.slice(0, offset))
}

function normalize(raw: string): string {
  let text = raw
    .replace(/[‘’‚‛]/g, "'") // curly apostrophes → ASCII '
    .replace(/[“”„‟]/g, '"') // curly quotes → ASCII "
    .replace(/[\u2013\u2014]/g, ' ') // en/em dashes → space (keeps phrase boundaries)
    .toLowerCase()
    .replace(/[\s\u00a0\u200b-\u200d\ufeff]+/g, ' ') // collapse all whitespace
    .trim()
  // kms → the phrase it stands for, so the existing rule catches it. Kept
  // Safari-safe (no lookbehind): the standalone token is rewritten, but a
  // digit-prefixed distance reading ("ran 5 kms") is left alone.
  text = text.replace(/\bkms\b/g, (token, offset) =>
    isDistanceShorthand(text, offset as number) ? token : 'kill myself',
  )
  return text
}

/** Characters that end a clause — a negator cannot reach across these. */
const CLAUSE_BREAKS = new Set(['.', ',', '!', '?', ';', ':', '—', '-', '(', ')', '…'])
/** Negating words as single normalised tokens ("do not" ends in "not"). */
const NEGATORS = new Set([
  'not', "don't", "won't", "didn't", "isn't", "aren't", "wasn't", "weren't",
  "can't", "couldn't", "wouldn't", "shouldn't", "haven't", "hasn't", "hadn't",
  "doesn't", 'never', 'no',
])
/** Small intensifiers that may sit between a negator and the phrase. */
const INTENSIFIERS = new Set([
  'really', 'just', 'even', 'ever', 'simply', 'actually', 'truly', 'literally', 'quite', 'remotely',
])

/**
 * True when a negator is the token (or one intensifier) immediately before
 * `index` in `text`. Safari-safe: no lookbehind — walks the text backwards,
 * stopping at clause punctuation so a negator from a previous sentence can
 * never leak in ("i can't. i want to die" still trips).
 */
function isNegatedAhead(text: string, index: number): boolean {
  const before = text.slice(0, index)
  const tokens: string[] = []
  let cursor = before.length - 1
  while (cursor >= 0 && tokens.length < 3) {
    const char = before[cursor]
    if (/\s/.test(char)) {
      cursor -= 1
      continue
    }
    if (CLAUSE_BREAKS.has(char) || !/[\w']/.test(char)) break
    const tokenEnd = cursor + 1
    let start = cursor
    while (start >= 0 && /[\w']/.test(before[start])) start -= 1
    tokens.push(before.slice(start + 1, tokenEnd))
    cursor = start
  }
  if (tokens.length === 0) return false
  if (NEGATORS.has(tokens[0])) return true
  if (tokens.length >= 2 && INTENSIFIERS.has(tokens[0]) && NEGATORS.has(tokens[1])) return true
  return false
}

/** Returns true when `rule.guard` matches within its window of `hitIndex`.
 * Negation-aware for hyperbole guards: a negated marker ("not a joke", "not
 * just kidding") asserts the intent is real and does NOT suppress. */
function guardTrips(text: string, hitIndex: number, rule: CrisisRule): boolean {
  const guard = rule.guard
  if (!guard) return false
  const windowChars = rule.guardWindow ?? DEFAULT_GUARD_WINDOW
  const start = Math.max(0, hitIndex - windowChars)
  const end = Math.min(text.length, hitIndex + windowChars)
  const guardHit = guard.exec(text.slice(start, end))
  if (guardHit === null) return false
  if (rule.guardNegationSensitive && isNegatedAhead(text, start + guardHit.index)) return false
  return true
}

/**
 * Deterministic crisis-signal check. Pure (no IO, no state), case-insensitive.
 *
 * @param input raw entry text, may be empty.
 * @returns every rule that tripped, ordered by `matchedAt` ascending (ties in
 *   rule order). An empty array means no signal — callers trip on
 *   `matches.length > 0`.
 */
export function checkCrisisSignal(input: string): CrisisMatch[] {
  // Defensive coercion: callers pass UI strings, but guard against nullish /
  // non-string input at runtime so the check can never throw on save.
  const text = normalize(String(input ?? ''))
  if (text.length === 0) return []

  const matches: CrisisMatch[] = []
  for (const rule of CRISIS_RULES) {
    const hit = rule.pattern.exec(text)
    if (hit === null) continue
    // First-person negation of the phrase ("i don't want to die") suppresses.
    if (rule.negationSuppresses && isNegatedAhead(text, hit.index)) continue
    if (rule.guard && guardTrips(text, hit.index, rule)) continue
    matches.push({ pattern: rule.label, matchedAt: hit.index })
  }

  return matches.sort((a, b) => a.matchedAt - b.matchedAt)
}
