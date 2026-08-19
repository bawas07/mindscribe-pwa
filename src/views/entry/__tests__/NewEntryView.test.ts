import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createMemoryHistory, createRouter, type Router } from 'vue-router'
import NewEntryView from '../NewEntryView.vue'
import { routes } from '../../../router'
import { decryptText, encryptText, getOrCreateDeviceKey } from '../../../lib/db/crypto'
import { db, ROLLING_SUMMARY_ROW_ID, type Entry } from '../../../lib/db/schema'
import { createEntry, listFollowupsForEntry, listRecentEntries } from '../../../lib/entries'
import { GENERIC_STUCK_PROMPTS } from '../../../lib/stuck-prompts'
import { modelClient } from '../../../lib/model/wllama-client'
import * as entriesModule from '../../../lib/entries'
import * as summaryModule from '../../../lib/model/summary'

let router: Router
let wrapper: VueWrapper

async function mountView() {
  // Fresh router per test, same as app-smoke.test.ts (no onboarding guard
  // on this instance — the guard lives on the default exported router).
  router = createRouter({ history: createMemoryHistory(), routes })
  router.push('/entry/new')
  await router.isReady()
  wrapper = mount(NewEntryView, { global: { plugins: [router] } })
}

function buttonByText(view: VueWrapper, text: string) {
  const button = view.findAll('button').find((candidate) => candidate.text().includes(text))
  if (!button) throw new Error(`No button containing "${text}"`)
  return button
}

/** Types an entry and taps Done → mood → Save (async work settles via vi.waitFor). */
async function writeAndSave(text: string, mood = '🙂') {
  await wrapper.find('.entry-sheet').setValue(text)
  await buttonByText(wrapper, 'Done').trigger('click')
  await buttonByText(wrapper, mood).trigger('click')
  await buttonByText(wrapper, 'Save entry').trigger('click')
}

beforeEach(async () => {
  await Promise.all(db.tables.map((table) => table.clear()))
})

afterEach(() => {
  wrapper?.unmount()
  vi.restoreAllMocks()
})

describe('NewEntryView (W6b) — frame 02 surface', () => {
  it('renders the journal-first writing surface: header, dominant textarea, meta, Done, stuck?', async () => {
    await mountView()

    expect(wrapper.find('.app-title').text()).toBe('New entry')
    expect(wrapper.find('.entry-sheet').attributes('placeholder')).toBe("What's on your mind…")
    expect(wrapper.find('.entry-meta').text()).toContain('thinking…')
    expect(buttonByText(wrapper, 'stuck?').exists()).toBe(true)
    expect(buttonByText(wrapper, 'Done').exists()).toBe(true)
    // No chat/follow-up elements in the free-write stage (W6b scope).
    expect(wrapper.find('.aside-card').exists()).toBe(false)
    expect(wrapper.find('.finish-label').exists()).toBe(false)
  })
})

describe('NewEntryView (W6b) — Done flow', () => {
  it('empty Done shows the gentle "Nothing to save yet." nudge and stays in the writing stage', async () => {
    await mountView()

    await buttonByText(wrapper, 'Done').trigger('click')

    expect(wrapper.find('.nudge').text()).toBe('Nothing to save yet.')
    expect(wrapper.find('.finish-label').exists()).toBe(false) // mood bar not open
  })

  it('Done with text opens the mood bar; Save without a mood nudges gently', async () => {
    await mountView()

    await wrapper.find('.entry-sheet').setValue('A quiet thought.')
    await buttonByText(wrapper, 'Done').trigger('click')

    expect(wrapper.find('.finish-label').text()).toBe('How did today feel?')
    await buttonByText(wrapper, 'Save entry').trigger('click')
    expect(wrapper.find('.nudge').text()).toBe('Pick how today felt first.')
  })
})

describe('NewEntryView (W6b) — stuck path (frames 03)', () => {
  it('reveals the aside card on "stuck?", rotates without repeating, and dismisses on "Just a plain page"', async () => {
    await mountView()

    await buttonByText(wrapper, 'stuck?').trigger('click')
    await flushPromises()

    const card = wrapper.find('.aside-card')
    expect(card.exists()).toBe(true)
    expect(card.find('.aside-eyebrow').text()).toBe('No pressure')
    // Empty journal → seed 0 → the pool's first prompt (deterministic, T8).
    expect(card.find('.aside-q').text()).toBe(GENERIC_STUCK_PROMPTS[0])

    await buttonByText(wrapper, 'Not this one, give me another').trigger('click')
    expect(wrapper.find('.aside-q').text()).toBe(GENERIC_STUCK_PROMPTS[1])

    await buttonByText(wrapper, 'Just a plain page').trigger('click')
    expect(wrapper.find('.aside-card').exists()).toBe(false)
    // The dominant textarea is untouched the whole time (never blocked).
    expect(wrapper.find('.entry-sheet').exists()).toBe(true)
  })
})

describe('NewEntryView (W6b) — save through the repository', () => {
  it('untripped save calls createEntry with the content + mood, persists encrypted, then returns to the dashboard', async () => {
    const createEntrySpy = vi.spyOn(entriesModule, 'createEntry')
    await mountView()

    await writeAndSave('A calm day by the river.', '🙂')

    await vi.waitFor(() => {
      expect(router.currentRoute.value.path).toBe('/')
    })
    expect(createEntrySpy).toHaveBeenCalledTimes(1)
    expect(createEntrySpy).toHaveBeenCalledWith({ content: 'A calm day by the river.', moodEmoji: '🙂' })

    // Encrypted at rest via the real repo path (the spy calls through).
    const recent = await listRecentEntries()
    expect(recent).toHaveLength(1)
    expect(recent[0].content).toBe('A calm day by the river.')

    const row = (await db.entries.get(recent[0].id)) as Entry
    expect(row.contentEncrypted.byteLength).toBeGreaterThan(12)
    expect(new TextDecoder().decode(new Uint8Array(row.contentEncrypted))).not.toContain('river')
    const key = await getOrCreateDeviceKey()
    expect(await decryptText(key, row.contentEncrypted)).toBe('A calm day by the river.')
  })

  it('a tripped entry flags the resource panel AFTER the save — the save is never blocked', async () => {
    await mountView()

    await writeAndSave('i want to kill myself tonight', '😔')

    // The save went through and the entry is readable — panel is post-save.
    await vi.waitFor(async () => {
      expect(await listRecentEntries()).toHaveLength(1)
    })
    const recent = await listRecentEntries()
    expect(recent[0].content).toContain('kill myself')

    // …but instead of navigating away, the gentle crisis card renders here.
    await vi.waitFor(() => {
      expect(wrapper.find('.crisis-overlay').exists()).toBe(true)
    })
    expect(wrapper.find('.crisis-headline').text()).toContain('We noticed something')
    expect(wrapper.find('.crisis-resource').exists()).toBe(true)
    expect(router.currentRoute.value.path).toBe('/entry/new')

    // Dismissing never loses the entry: it is already saved.
    await buttonByText(wrapper, 'Back to your journal').trigger('click')
    await vi.waitFor(() => {
      expect(router.currentRoute.value.path).toBe('/')
    })
    expect(wrapper.find('.crisis-overlay').exists()).toBe(false)
  })

  it('an untripped entry never shows the resource panel', async () => {
    await mountView()

    await writeAndSave('Just a regular Tuesday walk.', '😐')

    await vi.waitFor(() => {
      expect(router.currentRoute.value.path).toBe('/')
    })
    expect(wrapper.find('.crisis-overlay').exists()).toBe(false)
  })

  it('"keep writing" after a tripped save hides the card and opens a fresh blank page', async () => {
    await mountView()

    // Open the stuck-prompt card first — its state must not leak into the
    // fresh page after keep writing (W6b gate should-fix).
    await buttonByText(wrapper, 'stuck?').trigger('click')
    await flushPromises()
    expect(wrapper.find('.aside-card').exists()).toBe(true)

    await writeAndSave('i want to end my life', '😤')
    await vi.waitFor(() => {
      expect(wrapper.find('.crisis-overlay').exists()).toBe(true)
    })

    await buttonByText(wrapper, "I'm okay — keep writing").trigger('click')

    await vi.waitFor(() => {
      expect(wrapper.find('.crisis-overlay').exists()).toBe(false)
    })
    expect(wrapper.find('.entry-sheet').text()).toBe('') // fresh page, entry already saved
    expect(buttonByText(wrapper, 'Done').exists()).toBe(true) // back to writing stage
    expect(wrapper.find('.nudge').text()).toBe('Saved.')
    // The stuck card must not re-appear carrying the previous entry's prompt.
    expect(wrapper.find('.aside-card').exists()).toBe(false)
  })
})

describe('NewEntryView (W10) — opt-in follow-up flow', () => {
  // Above the FOLLOWUP_WORTHY_MIN_LENGTH floor and crisis-clean (T2).
  const WORTHY_ENTRY =
    'Spent the morning stuck on the call-graph traversal, then stepped away for coffee and it fell into place mid-pour.'
  const QUESTION_ONE = 'What did you find most refreshing about stepping away from the call-graph?'
  const QUESTION_TWO = 'What part of the walk felt most calming?'

  let statusSpy: ReturnType<typeof vi.spyOn>
  let generateFollowUpSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    // The model is already ready at mount: useModel's ensureReady()
    // short-circuits, so the real 657 MB model is never loaded. Tests that
    // need a not-ready client override statusSpy below.
    statusSpy = vi.spyOn(modelClient, 'getModelStatus').mockReturnValue({ state: 'ready' })
    // Saving an entry fires the W11 regen seam; with the client 'ready' it
    // would call generateThemes for real — stub it so saves stay CI-clean.
    vi.spyOn(modelClient, 'generateThemes').mockResolvedValue('{"themes":["work"]}')
    generateFollowUpSpy = vi.spyOn(modelClient, 'generateFollowUp').mockResolvedValue(QUESTION_ONE)
  })

  function hasButton(text: string): boolean {
    return wrapper.findAll('button').some((candidate) => candidate.text().includes(text))
  }

  /** Types a worthy entry, taps Done, accepts the opt-in, waits for the question card. */
  async function openQuestionCard(content: string = WORTHY_ENTRY): Promise<void> {
    await wrapper.find('.entry-sheet').setValue(content)
    await buttonByText(wrapper, 'Done').trigger('click')
    await buttonByText(wrapper, 'Yes, ask me something').trigger('click')
    await vi.waitFor(() => {
      expect(wrapper.find('.followup-question').exists()).toBe(true)
    })
  }

  it('empty content never triggers the opt-in; ANY non-empty entry does (no length heuristic)', async () => {
    await mountView()

    // Empty → gentle nudge, no card, no model call.
    await buttonByText(wrapper, 'Done').trigger('click')
    expect(wrapper.find('.nudge').text()).toBe('Nothing to save yet.')
    expect(wrapper.find('.followup-block').exists()).toBe(false)

    // Short but real entries qualify too — the old 40-char floor made the
    // feature feel broken on one-line entries (user-reported).
    await wrapper.find('.entry-sheet').setValue('Just a tiny note.') // 16 chars
    await buttonByText(wrapper, 'Done').trigger('click')
    expect(wrapper.find('.finish-label').exists()).toBe(true) // mood bar opens normally
    expect(wrapper.text()).toContain('Want to talk about this?')
    expect(generateFollowUpSpy).not.toHaveBeenCalled() // D5: nothing generated yet
  })

  it('Done with worthy, crisis-clean content offers the opt-in card with the two equal actions', async () => {
    await mountView()
    await wrapper.find('.entry-sheet').setValue(WORTHY_ENTRY)
    await buttonByText(wrapper, 'Done').trigger('click')

    const card = wrapper.find('.followup-card')
    expect(card.exists()).toBe(true)
    expect(card.find('.aside-eyebrow').text()).toBe('Want to talk about this?')
    expect(buttonByText(wrapper, 'Yes, ask me something').exists()).toBe(true)
    expect(buttonByText(wrapper, 'No thanks — just save').exists()).toBe(true)
    // D5: at the opt-in stage the model has generated nothing yet.
    expect(generateFollowUpSpy).not.toHaveBeenCalled()
  })

  it('Done with crisis-tripped content never offers the opt-in — the crisis path takes priority', async () => {
    await mountView()
    await wrapper
      .find('.entry-sheet')
      .setValue('i want to kill myself tonight, everything is falling apart around me')
    await buttonByText(wrapper, 'Done').trigger('click')

    expect(wrapper.find('.followup-block').exists()).toBe(false)
    expect(wrapper.text()).not.toContain('Want to talk about this?')
    expect(generateFollowUpSpy).not.toHaveBeenCalled()

    // The save still goes through and surfaces the resource panel (W6b).
    await buttonByText(wrapper, '😔').trigger('click')
    await buttonByText(wrapper, 'Save entry').trigger('click')
    await vi.waitFor(() => {
      expect(wrapper.find('.crisis-overlay').exists()).toBe(true)
    })
    expect(router.currentRoute.value.path).toBe('/entry/new')
  })

  it('"Yes, ask me something" presents the model question with "Skip this question" and keeps the textarea editable', async () => {
    await mountView()
    await openQuestionCard()

    const card = wrapper.find('.followup-card')
    expect(card.find('.aside-eyebrow').text()).toContain('One quick thing')
    expect(card.find('.aside-eyebrow').text()).toContain('1 of 2')
    expect(card.find('.followup-question').text()).toBe(QUESTION_ONE)
    expect(buttonByText(wrapper, 'Skip this question').exists()).toBe(true)
    // "One more?" must NOT appear before the question is answered or skipped.
    expect(hasButton('One more?')).toBe(false)

    // The dominant writing surface stays fully editable while the card is up.
    const textarea = wrapper.find('.entry-sheet')
    expect(textarea.exists()).toBe(true)
    expect(textarea.attributes('disabled')).toBeUndefined()
  })

  it('a free-written response is captured as the delta: save persists the entry AND the follow-up, then returns to the dashboard', async () => {
    await mountView()
    await openQuestionCard()

    const response = 'I think the coffee break helped most — the code untangled itself mid-pour.'
    await wrapper.find('.entry-sheet').setValue(`${WORTHY_ENTRY} ${response}`)

    await buttonByText(wrapper, '🙂').trigger('click')
    await buttonByText(wrapper, 'Save entry').trigger('click')
    await vi.waitFor(() => {
      expect(router.currentRoute.value.path).toBe('/')
    })

    const recent = await listRecentEntries()
    expect(recent).toHaveLength(1)
    // The entry row saves the Done-time text — the response is NOT doubled in.
    expect(recent[0].content).toBe(WORTHY_ENTRY)
    expect(recent[0].moodEmoji).toBe('🙂')

    const followups = await listFollowupsForEntry(recent[0].id)
    expect(followups).toHaveLength(1)
    expect(followups[0].question).toBe(QUESTION_ONE)
    expect(followups[0].response).toBe(response)

    // Encrypted at rest, and the flag flipped in the same write.
    const row = (await db.entries.get(recent[0].id)) as Entry
    expect(row.hasFollowup).toBe(true)
    const key = await getOrCreateDeviceKey()
    const fuRow = await db.followupResponses.where('entryId').equals(recent[0].id).first()
    expect(await decryptText(key, fuRow!.responseEncrypted)).toBe(response)
  })

  it('skip persists the question unanswered; "One more?" appears only after answer-or-skip, and the cap never allows a third', async () => {
    generateFollowUpSpy.mockResolvedValueOnce(QUESTION_ONE).mockResolvedValueOnce(QUESTION_TWO)
    await mountView()
    await openQuestionCard()

    // Before answering or skipping, the next-question offer is NOT shown.
    expect(hasButton('One more?')).toBe(false)

    await buttonByText(wrapper, 'Skip this question').trigger('click')
    // Only after the skip does the offer appear.
    expect(hasButton('One more?')).toBe(true)

    await buttonByText(wrapper, 'One more?').trigger('click')
    await vi.waitFor(() => {
      expect(wrapper.find('.followup-question').text()).toBe(QUESTION_TWO)
    })
    expect(wrapper.find('.aside-eyebrow').text()).toContain('2 of 2')

    // At the cap: no third question is ever offered.
    expect(hasButton('One more?')).toBe(false)
    await buttonByText(wrapper, 'Skip this question').trigger('click')
    expect(hasButton('One more?')).toBe(false)

    await buttonByText(wrapper, '😐').trigger('click')
    await buttonByText(wrapper, 'Save entry').trigger('click')
    await vi.waitFor(() => {
      expect(router.currentRoute.value.path).toBe('/')
    })

    // Exactly two questions were ever generated — never a third.
    expect(generateFollowUpSpy).toHaveBeenCalledTimes(2)

    const recent = await listRecentEntries()
    const followups = await listFollowupsForEntry(recent[0].id)
    expect(followups).toHaveLength(2)
    expect(followups.map((followup) => followup.question)).toEqual([QUESTION_ONE, QUESTION_TWO])
    // Skipped questions persist as rows whose response maps back to null.
    expect(followups.map((followup) => followup.response)).toEqual([null, null])
    expect((await db.entries.get(recent[0].id))?.hasFollowup).toBe(true)
  })

  it('"No thanks — just save" closes the opt-in; the entry saves alone with zero follow-ups and no model calls', async () => {
    await mountView()
    await wrapper.find('.entry-sheet').setValue(WORTHY_ENTRY)
    await buttonByText(wrapper, 'Done').trigger('click')
    await buttonByText(wrapper, 'No thanks — just save').trigger('click')

    expect(wrapper.find('.followup-block').exists()).toBe(false)
    expect(buttonByText(wrapper, 'Save entry').exists()).toBe(true)

    await buttonByText(wrapper, '😌').trigger('click')
    await buttonByText(wrapper, 'Save entry').trigger('click')
    await vi.waitFor(() => {
      expect(router.currentRoute.value.path).toBe('/')
    })

    const recent = await listRecentEntries()
    expect(recent).toHaveLength(1)
    expect(await db.followupResponses.count()).toBe(0)
    expect((await db.entries.get(recent[0].id))?.hasFollowup).toBe(false)
    expect(generateFollowUpSpy).not.toHaveBeenCalled()
  })

  it('ModelGate "Not now — just write for now" aborts to the plain journal; the entry still saves alone', async () => {
    // The model is NOT ready: the gate sheet shows while the load is in flight.
    statusSpy.mockReturnValue({ state: 'loading', loadedBytes: 0, totalBytes: 100 })
    let releaseLoad!: () => void
    const pendingLoad = new Promise<never>((resolve) => {
      releaseLoad = () => resolve(undefined as never)
    })
    vi.spyOn(modelClient, 'getModel').mockImplementation(() => pendingLoad)

    await mountView()
    await wrapper.find('.entry-sheet').setValue(WORTHY_ENTRY)
    await buttonByText(wrapper, 'Done').trigger('click')
    await buttonByText(wrapper, 'Yes, ask me something').trigger('click')
    await flushPromises()

    // The gate sheet is up (teleported) while the load is pending.
    expect(document.body.querySelector('.model-sheet')).not.toBeNull()

    const notNow = Array.from(document.body.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('Not now — just write for now'),
    )
    notNow?.dispatchEvent(new Event('click'))
    await flushPromises()

    // Aborted: back at the plain textarea, gate closed, no question ever asked.
    expect(buttonByText(wrapper, 'Done').exists()).toBe(true)
    expect(wrapper.find('.followup-block').exists()).toBe(false)
    expect(document.body.querySelector('.model-sheet')).toBeNull()
    expect(generateFollowUpSpy).not.toHaveBeenCalled()

    // The entry still saves alone — with zero follow-ups.
    releaseLoad()
    await flushPromises()
    await buttonByText(wrapper, 'Done').trigger('click')
    await buttonByText(wrapper, '🙂').trigger('click')
    await buttonByText(wrapper, 'Save entry').trigger('click')
    await vi.waitFor(() => {
      expect(router.currentRoute.value.path).toBe('/')
    })

    const recent = await listRecentEntries()
    expect(recent).toHaveLength(1)
    expect(recent[0].content).toBe(WORTHY_ENTRY)
    expect(await db.followupResponses.count()).toBe(0)
  })

  it('a failed model LOAD keeps the flow mounted with the ModelGate error sheet — it never silently vanishes', async () => {
    // Simulated failed download (404 / model files missing): the client
    // reports an error state, and getModel fails. Regression for the
    // "quick loading bar then nothing" bug: the flow must NOT be torn down,
    // because tearing it down unmounts the gate and hides its error sheet.
    statusSpy.mockReturnValue({ state: 'error', message: 'download failed' })
    vi.spyOn(modelClient, 'getModel').mockRejectedValue(new Error('download failed'))

    await mountView()
    await wrapper.find('.entry-sheet').setValue(WORTHY_ENTRY)
    await buttonByText(wrapper, 'Done').trigger('click')
    await buttonByText(wrapper, 'Yes, ask me something').trigger('click')
    await flushPromises()

    // The gate's error sheet is up with Retry / "Not now" — not "nothing".
    const sheet = document.body.querySelector('.model-sheet')
    expect(sheet).not.toBeNull()
    expect(sheet?.textContent).toContain('Something went wrong')
    const sheetButtons = Array.from((sheet as HTMLElement).querySelectorAll('button'))
    expect(sheetButtons.some((button) => button.textContent?.includes('Retry'))).toBe(true)

    // The flow was NOT torn down — the finish bar (mood + save) is still there.
    expect(wrapper.find('.followup-block').exists()).toBe(true)
    expect(wrapper.find('.finish-label').exists()).toBe(true)
    expect(buttonByText(wrapper, 'Save entry').exists()).toBe(true)
  })

  it('a question GENERATION failure shows a gentle inline note instead of vanishing', async () => {
    // Model is ready, but generating the question fails (e.g. the validator
    // rejected both attempts). The user must see a warm note, never silence.
    generateFollowUpSpy.mockRejectedValue(new Error('validator: not a question'))

    await mountView()
    await wrapper.find('.entry-sheet').setValue(WORTHY_ENTRY)
    await buttonByText(wrapper, 'Done').trigger('click')
    await buttonByText(wrapper, 'Yes, ask me something').trigger('click')

    await vi.waitFor(() => {
      expect(wrapper.text()).toContain("couldn't think of a question")
    })
    // Saving is untouched.
    expect(wrapper.find('.finish-label').exists()).toBe(true)
    expect(buttonByText(wrapper, 'Close this out').exists()).toBe(true)
  })

  it('a long multi-paragraph response ("stirred up and wrote a lot") is captured in full', async () => {
    await mountView()
    await openQuestionCard()

    const longResponse = [
      'It started when I was small, sitting on the bank with my grandfather while he smoked his pipe.',
      '',
      'The water never asked anything of me. It just kept moving, and somehow that was enough to make the noise in my head stand still.',
      '',
      'Even now, on the worst days, I walk down there and watch the light break across the surface — café, 中文, 🎉 — and I remember that I am allowed to stop.',
    ].join('\n')
    await wrapper.find('.entry-sheet').setValue(`${WORTHY_ENTRY}\n\n${longResponse}`)

    await buttonByText(wrapper, '😌').trigger('click')
    await buttonByText(wrapper, 'Save entry').trigger('click')
    await vi.waitFor(() => {
      expect(router.currentRoute.value.path).toBe('/')
    })

    const recent = await listRecentEntries()
    expect(recent[0].content).toBe(WORTHY_ENTRY)
    const followups = await listFollowupsForEntry(recent[0].id)
    expect(followups).toHaveLength(1)
    expect(followups[0].response).toBe(longResponse)
  })

  it('the swipe-peek affordance (D6) reveals the referenced entry behind the question', async () => {
    const previousId = await createEntry({ content: 'The river walk at dawn, quiet and cold.', moodEmoji: '🙂' })
    await mountView()
    await openQuestionCard()

    // The real question generation grounds in the recent entry, so the
    // peek affordance appears and reveals it.
    const handle = wrapper.find('.peek-handle')
    expect(handle.exists()).toBe(true)
    await handle.trigger('click')
    await flushPromises()

    const panel = wrapper.find('.peek-panel')
    expect(panel.exists()).toBe(true)
    expect(panel.text()).toContain('The river walk at dawn, quiet and cold.')
    expect(previousId).toBeTruthy()
  })
})

describe('NewEntryView (W9) — themed stuck path (frame 04, model-phrased tier 1)', () => {
  /** The standing fallback question for the seeded theme (entry count 0 → template 0). */
  const THEMED_TEMPLATE_FIRST =
    'You mentioned river walk recently — has anything shifted with it?'

  let statusSpy: ReturnType<typeof vi.spyOn>
  let getModelSpy: ReturnType<typeof vi.spyOn>
  let generateThemedSpy: ReturnType<typeof vi.spyOn>

  /** Seeds a readable rolling-summary row so getThemes() returns these themes. */
  async function seedSummary(
    themes: Array<{ topic: string; lastMentionedDaysAgo: number; mentionCount: number }>,
  ): Promise<void> {
    const key = await getOrCreateDeviceKey()
    await db.rollingSummary.put({
      id: ROLLING_SUMMARY_ROW_ID,
      generatedAt: new Date().toISOString(),
      themesEncrypted: await encryptText(key, JSON.stringify(themes)),
      sourceEntryCount: 2,
    })
  }

  /** Seeds a raw entry row (bypasses createEntry so no regen seam fires). */
  async function seedEntry(id: string, content: string): Promise<string> {
    const key = await getOrCreateDeviceKey()
    await db.entries.add({
      id,
      createdAt: new Date().toISOString(),
      contentEncrypted: await encryptText(key, content),
      moodEmoji: '',
      hasFollowup: false,
    })
    return id
  }

  beforeEach(() => {
    // Model UNAVAILABLE by default: a stuck reveal must never attempt a real
    // 657 MB load in CI. Tests that need the model flip status/calls below.
    statusSpy = vi.spyOn(modelClient, 'getModelStatus').mockReturnValue({ state: 'unloaded' })
    getModelSpy = vi
      .spyOn(modelClient, 'getModel')
      .mockRejectedValue(new Error('model not downloaded (test)'))
    generateThemedSpy = vi
      .spyOn(modelClient, 'generateThemedQuestion')
      .mockResolvedValue('unused?')
  })

  it('model unavailable: "stuck?" keeps the themed card on the TEMPLATE question — never an error, never the generic pool', async () => {
    await seedSummary([{ topic: 'River Walk', lastMentionedDaysAgo: 0, mentionCount: 2 }])
    await mountView()

    await buttonByText(wrapper, 'stuck?').trigger('click')
    await vi.waitFor(() => {
      expect(wrapper.find('.aside-q').text()).toBe(THEMED_TEMPLATE_FIRST)
    })

    const card = wrapper.find('.aside-card.from-memory')
    expect(card.exists()).toBe(true)
    expect(card.find('.aside-eyebrow').text()).toBe('From your recent entries')
    // The model was attempted (gate → load) but never became ready.
    expect(getModelSpy).toHaveBeenCalledTimes(1)
    expect(generateThemedSpy).not.toHaveBeenCalled()
    expect(wrapper.find('.load-error').exists()).toBe(false)
    // Still a light aside: the dominant textarea stays untouched and editable.
    expect(wrapper.find('.entry-sheet').exists()).toBe(true)
    expect(wrapper.find('.entry-sheet').attributes('disabled')).toBeUndefined()
  })

  it('"Not this one" walks the themed templates, then falls through to the generic pool (model unavailable)', async () => {
    await seedSummary([{ topic: 'river walk', lastMentionedDaysAgo: 0, mentionCount: 2 }])
    await mountView()

    await buttonByText(wrapper, 'stuck?').trigger('click')
    await vi.waitFor(() => {
      expect(wrapper.find('.aside-q').text()).toBe(THEMED_TEMPLATE_FIRST)
    })

    // Themed rotation, in template order (entry count 0 → template 0 first).
    await buttonByText(wrapper, 'Not this one, give me another').trigger('click')
    expect(wrapper.find('.aside-q').text()).toBe(
      "It sounded like river walk has been on your mind — what's it been like since?",
    )
    await buttonByText(wrapper, 'Not this one, give me another').trigger('click')
    expect(wrapper.find('.aside-q').text()).toBe(
      "Your recent entries touched on river walk — is there anything more you'd want to write about it?",
    )

    // Third press: themed exhausted → tier 2 (generic pool, seeded by entry count 0).
    await buttonByText(wrapper, 'Not this one, give me another').trigger('click')
    expect(wrapper.find('.aside-card').classes()).not.toContain('from-memory')
    expect(wrapper.find('.aside-eyebrow').text()).toBe('No pressure')
    expect(wrapper.find('.aside-q').text()).toBe(GENERIC_STUCK_PROMPTS[0])
  })

  it('a getThemes failure lands on tier 2 (generic) — the model is never touched', async () => {
    vi.spyOn(summaryModule, 'getThemes').mockRejectedValue(new Error('summary read failed'))
    await mountView()

    await buttonByText(wrapper, 'stuck?').trigger('click')
    await vi.waitFor(() => {
      expect(wrapper.find('.aside-card').exists()).toBe(true)
    })

    const card = wrapper.find('.aside-card')
    expect(card.classes()).not.toContain('from-memory')
    expect(card.find('.aside-eyebrow').text()).toBe('No pressure')
    expect(card.find('.aside-q').text()).toBe(GENERIC_STUCK_PROMPTS[0])
    expect(wrapper.find('.load-error').exists()).toBe(false)
    expect(getModelSpy).not.toHaveBeenCalled()
    expect(generateThemedSpy).not.toHaveBeenCalled()
  })

  it('no meaningful summary → tier 2 generic card (new-user path, model-free)', async () => {
    await mountView() // empty db: no rolling summary row, getThemes() == []

    await buttonByText(wrapper, 'stuck?').trigger('click')
    await vi.waitFor(() => {
      expect(wrapper.find('.aside-card').exists()).toBe(true)
    })

    const card = wrapper.find('.aside-card')
    expect(card.classes()).not.toContain('from-memory')
    expect(card.find('.aside-eyebrow').text()).toBe('No pressure')
    expect(card.find('.aside-q').text()).toBe(GENERIC_STUCK_PROMPTS[0])
    expect(getModelSpy).not.toHaveBeenCalled()
    expect(generateThemedSpy).not.toHaveBeenCalled()
  })

  it('with the model ready, "stuck?" renders the MODEL-phrased question, grounded in the mention entries', async () => {
    statusSpy.mockReturnValue({ state: 'ready' })
    await seedEntry('e-river', 'went for a river walk at dusk, quiet and cold')
    const modelQuestion = 'What has the river been like for you lately?'
    generateThemedSpy.mockResolvedValue(modelQuestion)
    await seedSummary([{ topic: 'river walk', lastMentionedDaysAgo: 0, mentionCount: 2 }])
    await mountView()

    await buttonByText(wrapper, 'stuck?').trigger('click')
    await vi.waitFor(() => {
      expect(wrapper.find('.aside-q').text()).toBe(modelQuestion)
    })

    const card = wrapper.find('.aside-card.from-memory')
    expect(card.exists()).toBe(true)
    expect(card.find('.aside-eyebrow').text()).toBe('From your recent entries')
    // The model question REPLACES the template phrasing.
    expect(wrapper.find('.aside-q').text()).not.toContain('You mentioned river walk recently')

    // Grounded: the theme's recency/recurrence and the entry that actually
    // mentions it reach the model (selectMentionEntries on the real journal).
    expect(generateThemedSpy).toHaveBeenCalledTimes(1)
    const context = generateThemedSpy.mock.calls[0][0]
    expect(context).toContain('THEME: "river walk"')
    expect(context).toContain('mentioned in 2 entries, last today.')
    expect(context).toContain('went for a river walk at dusk, quiet and cold')
  })

  it('a generation failure after its retry falls back to the template — same themed card, no error surface', async () => {
    statusSpy.mockReturnValue({ state: 'ready' })
    generateThemedSpy.mockRejectedValue(new Error('the model refused to phrase a question'))
    await seedSummary([{ topic: 'river walk', lastMentionedDaysAgo: 0, mentionCount: 2 }])
    await mountView()

    await buttonByText(wrapper, 'stuck?').trigger('click')
    await vi.waitFor(() => {
      expect(wrapper.find('.aside-q').text()).toBe(THEMED_TEMPLATE_FIRST)
    })

    const card = wrapper.find('.aside-card.from-memory')
    expect(card.exists()).toBe(true)
    expect(card.find('.aside-eyebrow').text()).toBe('From your recent entries')
    expect(wrapper.find('.load-error').exists()).toBe(false)
  })

  it('gate "Not now" during the download keeps the themed card on the template — the theme is never dropped to generic', async () => {
    statusSpy.mockReturnValue({ state: 'loading', loadedBytes: 0, totalBytes: 100 })
    let releaseLoad!: () => void
    const pendingLoad = new Promise<never>((resolve) => {
      releaseLoad = () => resolve(undefined as never)
    })
    getModelSpy.mockImplementation(() => pendingLoad)
    await seedSummary([{ topic: 'river walk', lastMentionedDaysAgo: 0, mentionCount: 2 }])
    await mountView()

    await buttonByText(wrapper, 'stuck?').trigger('click')

    // The download sheet is up (teleported) while the load is pending.
    await vi.waitFor(() => {
      expect(document.body.querySelector('.model-sheet')).not.toBeNull()
    })

    const notNow = Array.from(document.body.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('Not now — just write for now'),
    )
    notNow?.dispatchEvent(new Event('click'))
    await flushPromises()
    expect(document.body.querySelector('.model-sheet')).toBeNull()

    // The load finishes in the background; the card stays on the template.
    releaseLoad()
    await vi.waitFor(() => {
      expect(wrapper.find('.aside-q').text()).toBe(THEMED_TEMPLATE_FIRST)
    })

    const card = wrapper.find('.aside-card.from-memory')
    expect(card.exists()).toBe(true)
    expect(card.find('.aside-eyebrow').text()).toBe('From your recent entries')
    expect(card.find('.aside-q').text()).toBe(THEMED_TEMPLATE_FIRST)
    expect(generateThemedSpy).not.toHaveBeenCalled()
  })

  it('"Not this one" with the model ready asks the model again — a fresh question per press, still tier 1', async () => {
    statusSpy.mockReturnValue({ state: 'ready' })
    generateThemedSpy.mockResolvedValueOnce('Question one?').mockResolvedValueOnce('Question two?')
    await seedSummary([{ topic: 'river walk', lastMentionedDaysAgo: 0, mentionCount: 2 }])
    await mountView()

    await buttonByText(wrapper, 'stuck?').trigger('click')
    await vi.waitFor(() => {
      expect(wrapper.find('.aside-q').text()).toBe('Question one?')
    })

    await buttonByText(wrapper, 'Not this one, give me another').trigger('click')
    await vi.waitFor(() => {
      expect(wrapper.find('.aside-q').text()).toBe('Question two?')
    })

    expect(generateThemedSpy).toHaveBeenCalledTimes(2)
    expect(wrapper.find('.aside-card').classes()).toContain('from-memory')
  })
})