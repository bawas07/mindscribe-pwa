/**
 * W8 — wllama client state machine + self-hosted (C3) config correctness.
 *
 * The real ~657 MB model is never loaded here. @wllama/wllama is mocked at
 * the module boundary so we exercise the client's own logic: lazy load,
 * shared in-flight concurrency, progress reporting, error->retry, and the
 * exact constructor/setCompat/loadModelFromUrl wiring (asserting self-hosted
 * `/wasm/...` + `/models/...` paths and zero CDN references).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mock = vi.hoisted(() => {
  interface LoadParams {
    progressCallback?: (opts: { loaded: number; total: number }) => void
    n_ctx?: number
    default_template_kwargs?: Record<string, unknown>
    [key: string]: unknown
  }
  interface CompletionCall {
    messages: Array<{ role: string; content: string }>
    temperature?: number
    max_tokens?: number
    top_p?: number
    chat_template_kwargs?: Record<string, unknown>
    [key: string]: unknown
  }
  class MockWllama {
    static instances: MockWllama[] = []
    /** Per-test knobs picked up by the NEXT constructed instance. */
    static next: { progress?: Array<{ loaded: number; total: number }>; loadError?: Error | null; completionResult?: string } = {}

    readonly pathConfig: Record<string, string>
    compat: unknown = null
    shardUrl: string | null = null
    loadParams: LoadParams | null = null
    completionCalls: CompletionCall[] = []
    completionResult = ''

    constructor(pathConfig: Record<string, string>) {
      this.pathConfig = pathConfig
      const { progress, loadError, completionResult } = MockWllama.next
      void loadError
      this.completionResult = completionResult ?? 'mocked reply'
      this._progress = progress ?? []
      this._loadError = loadError ?? null
      MockWllama.instances.push(this)
    }

    _progress: Array<{ loaded: number; total: number }>
    _loadError: Error | null

    setCompat(compat: unknown): void {
      this.compat = compat
    }

    async loadModelFromUrl(url: string, params: LoadParams): Promise<void> {
      this.shardUrl = url
      this.loadParams = params
      for (const p of this._progress) {
        params.progressCallback?.({ loaded: p.loaded, total: p.total })
      }
      if (this._loadError) throw this._loadError
    }

    async createChatCompletion(params: Record<string, unknown>): Promise<unknown> {
      this.completionCalls.push(params as unknown as CompletionCall)
      return { choices: [{ message: { content: this.completionResult } }] }
    }
  }
  return { MockWllama }
})

vi.mock('@wllama/wllama', () => ({ Wllama: mock.MockWllama }))

import {
  MODEL_FILENAMES,
  MODEL_FIRST_SHARD_URL,
  MODEL_N_CTX,
  ENABLE_THINKING,
  FOLLOWUP_TEMPERATURE,
  THEMED_QUESTION_TEMPERATURE,
  THEMES_TEMPERATURE,
  WASM_ASSET_URLS,
  WASM_VERSION,
  modelClient,
  type ModelStatus,
} from '../wllama-client'

describe('WllamaClient state machine', () => {
  beforeEach(() => {
    mock.MockWllama.instances.length = 0
    mock.MockWllama.next = {}
    modelClient.reset()
  })

  it('starts unloaded and reaches ready after a lazy load', async () => {
    expect(modelClient.getModelStatus()).toEqual({ state: 'unloaded' })

    const statuses: ModelStatus[] = []
    const unsubscribe = modelClient.subscribe((s) => statuses.push(s))

    await modelClient.getModel()

    expect(statuses[0]).toEqual({ state: 'loading', loadedBytes: 0, totalBytes: 0 })
    expect(statuses[statuses.length - 1]).toEqual({ state: 'ready' })
    expect(modelClient.getModelStatus()).toEqual({ state: 'ready' })
    unsubscribe()
  })

  it('shares one in-flight load between concurrent callers', async () => {
    const first = modelClient.getModel()
    const second = modelClient.getModel()
    const third = modelClient.getModel()

    // One Wllama instance is created while the load is in flight.
    expect(mock.MockWllama.instances).toHaveLength(1)

    const results = await Promise.all([first, second, third])
    expect(results[0]).toBe(results[1])
    expect(results[1]).toBe(results[2])
    expect(mock.MockWllama.instances).toHaveLength(1)
  })

  it('returns the cached instance once ready (no reload)', async () => {
    await modelClient.getModel()
    const again = await modelClient.getModel()
    expect(again).toBeInstanceOf(mock.MockWllama)
    expect(mock.MockWllama.instances).toHaveLength(1)
  })

  it('reports byte progress while loading', async () => {
    mock.MockWllama.next.progress = [
      { loaded: 0, total: 100 },
      { loaded: 60, total: 100 },
      { loaded: 100, total: 100 },
    ]
    const statuses: ModelStatus[] = []
    const unsubscribe = modelClient.subscribe((s) => statuses.push(s))

    await modelClient.getModel()

    expect(statuses).toContainEqual({ state: 'loading', loadedBytes: 60, totalBytes: 100 })
    unsubscribe()
  })

  it('is retryable after a load failure', async () => {
    mock.MockWllama.next.loadError = new Error('network exploded')

    await expect(modelClient.getModel()).rejects.toThrow('network exploded')
    expect(modelClient.getModelStatus()).toMatchObject({
      state: 'error',
      message: 'network exploded',
    })

    // Next call starts a fresh load (new Wllama instance) and succeeds.
    mock.MockWllama.next.loadError = null
    const reloaded = await modelClient.getModel()
    expect(reloaded).toBeInstanceOf(mock.MockWllama)
    expect(mock.MockWllama.instances).toHaveLength(2)
    expect(modelClient.getModelStatus()).toEqual({ state: 'ready' })
  })

  it('unsubscribe stops listener delivery', async () => {
    const statuses: ModelStatus[] = []
    const unsubscribe = modelClient.subscribe((s) => statuses.push(s))
    unsubscribe()
    await modelClient.getModel()
    expect(statuses).toHaveLength(0)
  })
})

describe('self-hosted config correctness (spike C3, G3)', () => {
  beforeEach(() => {
    mock.MockWllama.instances.length = 0
    mock.MockWllama.next = {}
    modelClient.reset()
  })

  it('wires the primary wasm, compat assets and model shards to self-hosted paths — never a CDN', async () => {
    await modelClient.getModel()

    const instance = mock.MockWllama.instances[0]
    // Primary WASM via the constructor's `default` path.
    expect(instance.pathConfig.default).toBe(WASM_ASSET_URLS.primary)
    // Safari compat via setCompat with our origin's files.
    expect(instance.compat).toEqual({
      worker: WASM_ASSET_URLS.compatWorker,
      wasm: WASM_ASSET_URLS.compatWasm,
    })
    // Model load: first shard only, versioned, auto-joins the rest.
    expect(instance.shardUrl).toBe(MODEL_FIRST_SHARD_URL)
    expect(instance.shardUrl).toMatch(/^\/models\/MiniCPM5-1B-Q4_K_M-00001-of-00002\.gguf\?v=\d+$/)

    // Load knobs per spike §7.
    expect(instance.loadParams?.n_ctx).toBe(MODEL_N_CTX)
    expect(instance.loadParams?.default_template_kwargs).toEqual({ enable_thinking: ENABLE_THINKING })

    // The whole wired surface must stay off the network/CNDs.
    const wired = JSON.stringify([instance.pathConfig, instance.compat, instance.shardUrl])
    expect(wired).not.toMatch(/jsdelivr|cdn\./i)
  })

  it('self-hosted asset URL constants resolve under the app origin', () => {
    // W8 gate should-fix: wasm URLs are versioned (?v=) so a wllama upgrade
    // invalidates the SW cache and never serves stale wasm against new JS.
    expect(WASM_ASSET_URLS.primary).toBe(`/wasm/wllama.wasm?v=${WASM_VERSION}`)
    expect(WASM_ASSET_URLS.compatWorker).toBe(`/wasm/compat/wllama.js?v=${WASM_VERSION}`)
    expect(WASM_ASSET_URLS.compatWasm).toBe(`/wasm/compat/wllama.wasm?v=${WASM_VERSION}`)
    expect(MODEL_FIRST_SHARD_URL).toContain(`/models/${MODEL_FILENAMES[0]}`)
    expect(MODEL_FILENAMES).toHaveLength(2)
  })
})

describe('generation seam (system prompts + validated config)', () => {
  beforeEach(() => {
    mock.MockWllama.instances.length = 0
    mock.MockWllama.next = {}
    modelClient.reset()
  })

  it('generateFollowUp attaches the Task A system prompt + spike C2 config', async () => {
    mock.MockWllama.next.completionResult = 'What made today better?'
    const result = await modelClient.generateFollowUp('Today was good.')

    expect(result).toBe('What made today better?')
    const call = mock.MockWllama.instances[0].completionCalls[0]
    expect(call.messages[0].role).toBe('system')
    expect(call.messages[0].content).toContain('journal')
    expect(call.messages[1]).toEqual({ role: 'user', content: 'Today was good.' })
    expect(call.temperature).toBe(FOLLOWUP_TEMPERATURE)
    expect(call.chat_template_kwargs).toEqual({ enable_thinking: ENABLE_THINKING })
  })

  it('generateThemes attaches the Task B system prompt + themes config (C1 shell)', async () => {
    mock.MockWllama.next.completionResult = '{"themes":["river walks","work"]}'
    const result = await modelClient.generateThemes('RECENT (2 days ago): river again.')

    expect(result).toBe('{"themes":["river walks","work"]}')
    const call = mock.MockWllama.instances[0].completionCalls[0]
    expect(call.messages[0].role).toBe('system')
    expect(call.messages[0].content).toContain('"themes"')
    expect(call.temperature).toBe(THEMES_TEMPERATURE)
  })

  it('generateThemedQuestion attaches the W9 themed system prompt + spike C2 config', async () => {
    mock.MockWllama.next.completionResult = 'Has anything shifted with the river walk?'
    const result = await modelClient.generateThemedQuestion('THEME: "river walk"')

    expect(result).toBe('Has anything shifted with the river walk?')
    const call = mock.MockWllama.instances[0].completionCalls[0]
    expect(call.messages[0].role).toBe('system')
    // The non-CBT guardrails live in the prompt itself.
    expect(call.messages[0].content).toContain('reframe')
    expect(call.messages[0].content.toLowerCase()).toContain('non-presumptuous')
    expect(call.messages[1]).toEqual({ role: 'user', content: 'THEME: "river walk"' })
    expect(call.temperature).toBe(THEMED_QUESTION_TEMPERATURE)
    expect(call.chat_template_kwargs).toEqual({ enable_thinking: ENABLE_THINKING })
  })

  it('overrides let the retry layer raise temperature (W10/W11 seam)', async () => {
    await modelClient.generateFollowUp('x', { temperature: 0.7 })
    const call = mock.MockWllama.instances[0].completionCalls[0]
    expect(call.temperature).toBe(0.7)
  })

  it('createCompletion exposes the raw content surface', async () => {
    mock.MockWllama.next.completionResult = ' raw reply '
    const out = await modelClient.createCompletion({
      messages: [{ role: 'user', content: 'hi' }],
      temperature: 0.9,
    })
    expect(out).toBe(' raw reply ')
  })
})
