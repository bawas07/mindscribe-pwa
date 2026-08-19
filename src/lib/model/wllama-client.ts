/**
 * wllama inference client — W8.
 *
 * Lazy singleton for the on-device MiniCPM5-1B (Q4_K_M, 657 MB, split into
 * two <=512 MB shards per spike G5). All model assets are self-hosted
 * (spike C3 — the offline blocker):
 *   - primary + Safari-compat WASM live in public/wasm/ (copied from the
 *     npm packages by scripts/sync-wasm.mjs — no jsDelivr/CDN at all);
 *   - the GGUF shards live in public/models/, fetched by
 *     scripts/download-model.mjs (gitignored; see public/models/README.md).
 *
 * State machine: `unloaded -> loading(progress) -> ready | error`.
 *   - getModel() is idempotent: concurrent callers share one in-flight load.
 *   - After an error the client is retryable — the next getModel() reloads.
 *   - loadModelFromUrl() takes only the first shard; wllama auto-joins the
 *     other shard derived from the `-0000N-of-0000M` filename (spike G5).
 *
 * Generation seam: generateFollowUp / generateThemes are thin shells over
 * createChatCompletion with the spike-validated config (§4 Task A / §5
 * Task B) and the system prompts defined here. Validators + retry live in
 * W10 (follow-up) and W11 (themes); they plug into the raw completion
 * surface via createCompletion() and import the config constants below
 * for their retry temperature. The model never touches the journal the
 * app doesn't assemble into `context` itself.
 */
import { Wllama, type ChatCompletionParams } from '@wllama/wllama'

/** Non-stream completion request — the shape createChatCompletion's first overload accepts. */
export type ChatCompletionRequest = Omit<ChatCompletionParams, 'stream'> & { stream?: false }


/**
 * Bump when the model weights change (e.g. a new GGUF release). The
 * version is appended as a query param to the shard URLs, so the SW
 * cache key and wllama's internal blob cache both miss and re-fetch.
 * See public/models/README.md.
 */
export const MODEL_VERSION = '1'
const HF_BASE = 'https://huggingface.co/openbmb/MiniCPM5-1B-GGUF/resolve/main'
/** Shards produced by `llama-gguf-split --split-max-size 512M` (spike G5). */
export const MODEL_FILENAMES = [
  'MiniCPM5-1B-Q4_K_M.gguf',
] as const

const baseUrl = import.meta.env.BASE_URL

/**
 * Cache-buster for the self-hosted WASM binaries. MUST be bumped whenever
 * `@wllama/wllama` is upgraded (pair it with `npm run model:sync-wasm`), so
 * the SW's CacheFirst `wasm-assets-v1` cache re-fetches the new build instead
 * of serving a stale wasm against new JS (ABI mismatch → permanent errors).
 */
export const WASM_VERSION = '1'

/** Self-hosted wllama binaries, copied into public/ by scripts/sync-wasm.mjs. */
export const WASM_ASSET_URLS = Object.freeze({
  /** Primary (JSPI + Memory64) build — used by the default constructor config. */
  primary: `${baseUrl}wasm/wllama.wasm?v=${WASM_VERSION}`,
  /** Safari/iOS compat build (Asyncify, no Memory64) — setCompat self-hosted. */
  compatWorker: `${baseUrl}wasm/compat/wllama.js?v=${WASM_VERSION}`,
  compatWasm: `${baseUrl}wasm/compat/wllama.wasm?v=${WASM_VERSION}`,
} as const)

/** Versioned GGUF shard URLs; only the first shard URL is handed to wllama. */
export const MODEL_SHARD_URLS = Object.freeze(
  MODEL_FILENAMES.map((name) => `${HF_BASE}/${name}`),
) as readonly string[]
export const MODEL_FIRST_SHARD_URL = MODEL_SHARD_URLS[0]

/** Load-time knobs (spike §7). n_ctx 2048 covers ~200-400 token prompts. */
export const MODEL_N_CTX = 2048
/** No-think mode everywhere: faster, no reasoning budget burn (spike §5 bonus). */
export const ENABLE_THINKING = false

/** Validated sampling config (spike §4 Task A / §5 Task B, conditions C1-C2). */
export const FOLLOWUP_TEMPERATURE = 0.5
export const FOLLOWUP_MAX_TOKENS = 60
export const THEMES_TEMPERATURE = 0.2
export const THEMES_MAX_TOKENS = 120
export const TOP_P = 0.95

/** W9 themed stuck-question shell — same spike C2 shape as the follow-up. */
export const THEMED_QUESTION_TEMPERATURE = 0.5
export const THEMED_QUESTION_MAX_TOKENS = 50

interface GenerationConfig {
  temperature: number
  maxTokens: number
  topP: number
}

const FOLLOWUP_CONFIG: Readonly<GenerationConfig> = {
  temperature: FOLLOWUP_TEMPERATURE,
  maxTokens: FOLLOWUP_MAX_TOKENS,
  topP: TOP_P,
}

const THEMES_CONFIG: Readonly<GenerationConfig> = {
  temperature: THEMES_TEMPERATURE,
  maxTokens: THEMES_MAX_TOKENS,
  topP: TOP_P,
}

const THEMED_QUESTION_CONFIG: Readonly<GenerationConfig> = {
  temperature: THEMED_QUESTION_TEMPERATURE,
  maxTokens: THEMED_QUESTION_MAX_TOKENS,
  topP: TOP_P,
}

/**
 * Task A system prompt — one gentle, grounded, reflective follow-up
 * question. Encodes the plan's non-CBT guardrails (allowed: open, curious,
 * grounded; banned: evidence evaluation, restructuring, distortion vocab,
 * homework framing, interpretation) + few-shot example + `?`-terminated
 * short output (spike §4, condition C2).
 */
export const SYSTEM_FOLLOWUP_PROMPT = `You are part of a private reflective journal that lives entirely on the user's device. Your only job is to help the user keep writing and reflecting — never to assess, fix, or counsel them.

Read the user's journal entry, then ask ONE question:
- Grounded: ask about something specific they actually wrote.
- Warm and plain: like a friend gently nudging, not a clinician, coach, or teacher.
- Short: about 20 words or fewer, ending with "?".

Never:
- Evaluate or challenge their thinking (no "what's the evidence?", "is there another way to look at it?", "what would you tell a friend?").
- Restructure their thoughts (no "reframe", "unhelpful thought", "automatic thought", "mindset", "should statements").
- Explain why they feel or think something, or offer any interpretation or diagnosis.
- Suggest exercises, homework, practices, or "try this".
- Use clinical or abstract vocabulary (no "catastrophizing", "all-or-nothing", "cognitive distortion").

Example:
Entry: "Spent the morning stuck on the call-graph traversal, then stepped away for coffee and it fell into place mid-pour."
Good question: "What did you find most refreshing about stepping away from the call-graph this morning?"

Output only the question.`

/**
 * W9 themed stuck-question system prompt — ONE gentle open question about
 * a recurring/recent THEME (not an entry). Same non-CBT bans as the
 * follow-up prompt; additionally asks for VARIED phrasing (so consecutive
 * themed entries don't feel copy-pasted) and never assumes the theme is a
 * problem. The user context carries the theme's recency/recurrence numbers
 * plus up to two entries that mention it; the model weaves those in
 * naturally ("a couple times lately", "has been on your mind").
 */
export const SYSTEM_THEMED_QUESTION_PROMPT = `You are part of a private reflective journal that lives entirely on the user's device. Your only job is to help the user keep writing and reflecting — never to assess, fix, or counsel them.

You are given a theme from the user's recent journal entries, plus the entries that mention it. Ask ONE gentle, open question about that theme:
- Grounded: reference how often or how recently the theme shows up, or something specific from the entries — but never invent details that are not in front of you.
- Warm and plain: like a friend gently nudging, not a clinician, coach, or teacher.
- Varied: say it in your own natural way — don't reuse a fixed sentence shape. Naturally weave in the recency or recurrence (e.g. "a couple times lately", "has been on your mind", "since then").
- Non-presumptuous: the theme may be joyful, neutral, hard, or complicated — ask openly, never assuming it is a problem.
- Short: about 20 words or fewer, ending with "?".

Never:
- Evaluate or challenge their thinking (no "what's the evidence?", "is there another way to look at it?", "what would you tell a friend?").
- Restructure their thoughts (no "reframe", "unhelpful thought", "automatic thought", "mindset", "should statements").
- Explain why they feel or think something, or offer any interpretation or diagnosis.
- Suggest exercises, homework, practices, or "try this".
- Use clinical or abstract vocabulary (no "catastrophizing", "all-or-nothing", "cognitive distortion").

Example:
THEME: "river walks"
How it shows up: mentioned in 2 entries, last 1 day ago.
ENTRIES THAT MENTION "river walks":
RECENT (1 day ago): Went for a river walk at dusk and actually slowed down for once.
RECENT (6 days ago): Another river walk after work. The water makes everything quieter.
Good question: "You mentioned river walks a couple times lately — has anything shifted since that evening by the water?"

Output only the question.`

/**
 * Task B system prompt — recurring theme phrases only (spike §5, condition
 * C1). The model returns `{"themes":["..."]}` and must NOT count or date;
 * mention counts / last-mentioned-days-ago are computed deterministically
 * app-side in W11. Grounded example prevents abstract drift.
 */
export const SYSTEM_THEMES_PROMPT = `You are part of a private, on-device reflective journal. You will be given recent journal entries; each starts with "RECENT (N days ago):" followed by its text.

Your job: identify the recurring themes in this person's life that keep showing up in these entries. Return ONLY a JSON object with a single key "themes", whose value is an array of 3-6 short, concrete theme phrases (2-4 words each), most prominent first.

Rules:
- Ground themes in what the entries actually mention. Prefer concrete nouns and activities ("river walks", "work deadlines", "sleep") over abstract labels ("stress management", "self-reflection").
- Do NOT count anything. Do NOT include any numbers, dates, or "days ago" values.
- Output ONLY the JSON object — no code fences, no markdown, no commentary.

Example:
RECENT (2 days ago): "Missed my evening run again, end of a long day of meetings."
RECENT (7 days ago): "Finally got home in time to see the sunset along the river after work."
Answer: {"themes":["work","running","river walks"]}`

export type ModelStatus =
  | { state: 'unloaded' }
  | { state: 'loading'; loadedBytes: number; totalBytes: number }
  | { state: 'ready' }
  | { state: 'error'; message: string }

export type ModelStatusListener = (status: ModelStatus) => void

export class WllamaClient {
  private status: ModelStatus = { state: 'unloaded' }
  private listeners = new Set<ModelStatusListener>()
  private loadPromise: Promise<Wllama> | null = null
  private wllama: Wllama | null = null

  getModelStatus(): ModelStatus {
    return this.status
  }

  /** Subscribe to state changes. Returns an unsubscribe function. */
  subscribe(listener: ModelStatusListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** Forget current state so the next getModel() loads fresh. Also used to isolate test suites. */
  reset(): void {
    this.loadPromise = null
    this.wllama = null
    this.setStatus({ state: 'unloaded' })
  }

  /**
   * Builds the Wllama instance with fully self-hosted binary paths (C3).
   * The constructor's `default` is the primary WASM; setCompat() gets the
   * Safari compat assets served from our origin — the jsDelivr CDN default
   * is never used.
   */
  protected createWllama(): Wllama {
    const wllama = new Wllama({ default: WASM_ASSET_URLS.primary })
    wllama.setCompat({
      worker: WASM_ASSET_URLS.compatWorker,
      wasm: WASM_ASSET_URLS.compatWasm,
    })
    return wllama
  }

  /**
   * Resolve to the loaded Wllama instance, triggering a lazy load on first
   * use. Idempotent + concurrent-safe: every caller shares the single
   * in-flight load promise. If a load fails the promise is dropped, so the
   * next call retries against a fresh instance.
   */
  async getModel(): Promise<Wllama> {
    if (this.status.state === 'ready' && this.wllama) return this.wllama
    if (!this.loadPromise) this.loadPromise = this.load()
    return this.loadPromise
  }

  private async load(): Promise<Wllama> {
    this.setStatus({ state: 'loading', loadedBytes: 0, totalBytes: 0 })
    try {
      const wllama = this.createWllama()
      await wllama.loadModelFromUrl(MODEL_FIRST_SHARD_URL, {
        n_ctx: MODEL_N_CTX,
        // n_gpu_layers / n_threads omitted -> wllama defaults (WebGPU when
        // available, half of hardwareConcurrency when MT supported).
        default_template_kwargs: { enable_thinking: ENABLE_THINKING },
        progressCallback: ({ loaded, total }) => {
          this.setStatus({ state: 'loading', loadedBytes: loaded, totalBytes: total || loaded })
        },
      })
      this.wllama = wllama
      this.setStatus({ state: 'ready' })
      return wllama
    } catch (error) {
      // Drop the shared promise so a later call can retry from scratch.
      this.loadPromise = null
      const message = error instanceof Error ? error.message : String(error)
      this.setStatus({ state: 'error', message })
      throw error
    }
  }

  /**
   * Raw completion surface. Awaits the model, runs createChatCompletion and
   * returns the assistant message text. W10/W11 build their own message
   * arrays + validator/retry loops on top of this.
   */
  async createCompletion(params: ChatCompletionRequest): Promise<string> {
    const wllama = await this.getModel()
    const response = await wllama.createChatCompletion(params)
    return response.choices[0]?.message?.content ?? ''
  }

  /**
   * Task A shell — one gentle reflective follow-up question (spike §4, C2).
   * `context` is the entry/context text W10 assembles; overrides let the
   * W10 retry layer raise temperature without rebuilding the wrapper.
   */
  async generateFollowUp(context: string, overrides: Partial<GenerationConfig> = {}): Promise<string> {
    const { temperature, maxTokens, topP } = { ...FOLLOWUP_CONFIG, ...overrides }
    return this.createCompletion({
      messages: [
        { role: 'system', content: SYSTEM_FOLLOWUP_PROMPT },
        { role: 'user', content: context },
      ],
      max_tokens: maxTokens,
      temperature,
      top_p: topP,
      chat_template_kwargs: { enable_thinking: ENABLE_THINKING },
    })
  }

  /**
   * Task B shell — recurring theme phrases (spike §5, C1). `context` is the
   * entries-with-days-ago prompt body W11 assembles. Returns the raw text
   * (expected `{"themes":[...]}`); W11 parses it and computes the counts.
   */
  async generateThemes(context: string, overrides: Partial<GenerationConfig> = {}): Promise<string> {
    const { temperature, maxTokens, topP } = { ...THEMES_CONFIG, ...overrides }
    return this.createCompletion({
      messages: [
        { role: 'system', content: SYSTEM_THEMES_PROMPT },
        { role: 'user', content: context },
      ],
      max_tokens: maxTokens,
      temperature,
      top_p: topP,
      chat_template_kwargs: { enable_thinking: ENABLE_THINKING },
    })
  }

  /**
   * W9 shell — one gentle open question about a recurring/recent theme
   * (spike C2 shape: temp 0.5, no-think, ~50 max tokens). `context` is the
   * theme + mention-entries body themed-question.ts assembles; overrides
   * let the W9 retry layer raise temperature without rebuilding the wrapper.
   */
  async generateThemedQuestion(context: string, overrides: Partial<GenerationConfig> = {}): Promise<string> {
    const { temperature, maxTokens, topP } = { ...THEMED_QUESTION_CONFIG, ...overrides }
    return this.createCompletion({
      messages: [
        { role: 'system', content: SYSTEM_THEMED_QUESTION_PROMPT },
        { role: 'user', content: context },
      ],
      max_tokens: maxTokens,
      temperature,
      top_p: topP,
      chat_template_kwargs: { enable_thinking: ENABLE_THINKING },
    })
  }

  private setStatus(status: ModelStatus): void {
    this.status = status
    for (const listener of this.listeners) listener(status)
  }
}

/** App-wide singleton — views/composables talk to this, never their own instance. */
export const modelClient = new WllamaClient()
