import { describe, expect, it } from 'vitest'
import { checkCrisisSignal, type CrisisMatch } from '../crisis-check'

/** Labels only — convenient for readable assertions regardless of ordering. */
function labelsOf(matches: CrisisMatch[]): string[] {
  return matches.map((match) => match.pattern)
}

/** Pins the matchedAt semantics: index into the normalised (lowercased, trimmed) text. */
function normalisedOf(raw: string): string {
  // Mirrors the cheap normalisation in crisis-check.ts (see module docstring).
  return raw
    .replace(/[‘’‚‛]/g, "'")
    .replace(/[“”„‟]/g, '"')
    .replace(/[\u2013\u2014]/g, ' ')
    .toLowerCase()
    .replace(/[\s\u00a0\u200b-\u200d\ufeff]+/g, ' ')
    .trim()
    .replace(/(?<!\d[\s.,]?)\bkms\b/g, 'kill myself')
}

describe('checkCrisisSignal — tripped phrases', () => {
  it('flags explicit "i want to die"', () => {
    expect(labelsOf(checkCrisisSignal('i want to die'))).toEqual(['want to die'])
  })

  it('flags "i am going to kill myself" (and the kms shorthand)', () => {
    expect(labelsOf(checkCrisisSignal('i am going to kill myself'))).toContain('kill myself')
    expect(labelsOf(checkCrisisSignal('sometimes i just want to kms'))).toContain('kill myself')
  })

  it('flags planning / method / intent families', () => {
    expect(labelsOf(checkCrisisSignal('i plan to end my life'))).toContain('end my life')
    expect(labelsOf(checkCrisisSignal('she wants to end her life'))).toContain('end my life')
    expect(labelsOf(checkCrisisSignal('i am going to end it all'))).toContain('end it all')
    expect(labelsOf(checkCrisisSignal('i might take my own life'))).toContain('take my life')
    expect(labelsOf(checkCrisisSignal('i wish i was dead'))).toContain('wish i was dead')
    expect(labelsOf(checkCrisisSignal('it would be better off dead'))).toContain('better off dead')
    expect(labelsOf(checkCrisisSignal('i have no reason to live'))).toContain('no reason to live')
    expect(labelsOf(checkCrisisSignal('nothing left to live for'))).toContain('nothing to live for')
    expect(labelsOf(checkCrisisSignal('life is not worth living'))).toContain('not worth living')
    expect(labelsOf(checkCrisisSignal('i am ready to die'))).toContain('ready to die')
    // Past-tense recall of suicidal feelings still warrants a nudge.
    expect(labelsOf(checkCrisisSignal('i have wanted to die for months'))).toContain('want to die')
  })

  it('still trips when genuine grief/illness overlaps the hyperbole window', () => {
    // Bare "dying" must not count as a laughter marker (regression for the
    // "die laughing" guard): a real grief sentence must still trip.
    expect(labelsOf(checkCrisisSignal('my grandma is dying and i want to die'))).toContain('want to die')
  })

  it('trips when suicidal intent is asserted past a denial-of-hyperbole', () => {
    // "not a joke" / "not just a joke" / "i'm not kidding" assert the intent
    // is real — they must trip, not be swallowed by a joke/kidding hyperbole
    // marker.
    expect(labelsOf(checkCrisisSignal("this isn't a joke, i want to die"))).toContain('want to die')
    expect(labelsOf(checkCrisisSignal("i want to die and i'm not joking"))).toContain('want to die')
    expect(labelsOf(checkCrisisSignal("i want to die, i'm not kidding"))).toContain('want to die')
    expect(labelsOf(checkCrisisSignal('i want to die and it\'s not just a joke'))).toContain('want to die')
  })

  it('trips on genuine reasons / persons, not just bare proximity', () => {
    // Reason-introducers and abstractions are NOT locations: these are real
    // signals and must trip.
    expect(labelsOf(checkCrisisSignal("i don't want to live because everything hurts"))).toContain(
      "don't want to live",
    )
    expect(labelsOf(checkCrisisSignal("i don't want to live with this pain anymore"))).toContain(
      "don't want to live",
    )
  })

  it('trips on bare laughter proximity and on the exhausted phrasing', () => {
    // Bare "laughing" near the phrase is not an idiom — "everyone's laughing
    // at me" is a real signal context and must trip.
    expect(labelsOf(checkCrisisSignal("everyone's laughing at me, i want to die"))).toContain('want to die')
    // "can't go on any further" is the exhausted crisis phrasing.
    expect(labelsOf(checkCrisisSignal("i can't go on any further"))).toContain("can't go on")
  })

  it('flags crisis-method and preparatory details even when partially benign words appear', () => {
    // "with glass" is a method, not the benign "on glass" object-cut reading.
    expect(labelsOf(checkCrisisSignal('i cut my wrists with glass'))).toContain('cut myself')
    // "when i was" has no leaving verb, so this preparatory statement trips.
    expect(labelsOf(checkCrisisSignal('i wrote a suicide note when i was at my lowest'))).toContain(
      'goodbye note',
    )
  })

  it('flags "don\'t want to live / be alive" without a location/comparison', () => {
    expect(labelsOf(checkCrisisSignal("i don't want to live anymore"))).toContain("don't want to live")
    expect(labelsOf(checkCrisisSignal("i don't want to be alive"))).toContain("don't want to live")
    expect(labelsOf(checkCrisisSignal('i do not want to be alive'))).toContain("don't want to live")
  })

  it('flags "cannot / do not" spellings of the contractions', () => {
    expect(labelsOf(checkCrisisSignal('i cannot go on'))).toContain("can't go on")
    expect(labelsOf(checkCrisisSignal('i can not go on any longer'))).toContain("can't go on")
    expect(labelsOf(checkCrisisSignal('i do not want to wake up'))).toContain("don't want to wake up")
  })

  it('flags bare "suicide" when self-directed ("suicidal thoughts")', () => {
    expect(labelsOf(checkCrisisSignal('i have been having suicidal thoughts'))).toContain('suicide')
    expect(labelsOf(checkCrisisSignal('i keep thinking about suicide'))).toContain('suicide')
  })

  it('flags self-harm language', () => {
    expect(labelsOf(checkCrisisSignal('i cut myself last night'))).toContain('cut myself')
    expect(labelsOf(checkCrisisSignal('i cut my wrists'))).toContain('cut myself')
    expect(labelsOf(checkCrisisSignal('i hurt myself and i dont care'))).toContain('hurt myself')
    expect(labelsOf(checkCrisisSignal('self harming again'))).toContain('self-harm')
    expect(labelsOf(checkCrisisSignal('overdosed on pills'))).toContain('overdose')
    expect(labelsOf(checkCrisisSignal('thinking about hanging myself'))).toContain('hang myself')
    expect(labelsOf(checkCrisisSignal('slit my wrists'))).toContain('slit my wrists')
    expect(labelsOf(checkCrisisSignal('planning to jump off a bridge'))).toContain('jump off a bridge')
    expect(labelsOf(checkCrisisSignal('want to jump in front of a train'))).toContain('jump in front of traffic')
  })

  it('flags passive / preparatory signals', () => {
    expect(labelsOf(checkCrisisSignal('nobody would miss me if i was gone'))).toContain('nobody would miss me')
    expect(labelsOf(checkCrisisSignal('no one cares when i go missing'))).toContain('nobody would miss me')
    expect(labelsOf(checkCrisisSignal('no one would even care if i disappeared'))).toContain('nobody would miss me')
    expect(labelsOf(checkCrisisSignal('everyone would be better off without me'))).toContain('better off without me')
    expect(labelsOf(checkCrisisSignal('i am done with life'))).toContain('done with life')
    expect(labelsOf(checkCrisisSignal('i have given up on living'))).toContain('given up on life')
    expect(labelsOf(checkCrisisSignal('i just want to end the pain'))).toContain('end the pain')
    expect(labelsOf(checkCrisisSignal('i wrote a farewell note'))).toContain('goodbye note')
    expect(labelsOf(checkCrisisSignal('i want to disappear'))).toContain('want to disappear')
    expect(labelsOf(checkCrisisSignal('i don\'t want to wake up'))).toContain("don't want to wake up")
    expect(labelsOf(checkCrisisSignal('i can\'t go on'))).toContain("can't go on")
  })
})

describe('checkCrisisSignal — benign near-misses MUST NOT trip', () => {
  it('ignores technical / sports / literal readings', () => {
    expect(checkCrisisSignal('kill the process and restart the server')).toEqual([])
    expect(checkCrisisSignal('they ended it in overtime with a buzzer beater')).toEqual([])
    expect(checkCrisisSignal('the weekend is finally ending')).toEqual([]) // weekend ≠ end it all
    expect(checkCrisisSignal('jump off this topic for a second')).toEqual([])
    expect(checkCrisisSignal('life is worth living')).toEqual([])
    expect(checkCrisisSignal('the workload is killing me')).toEqual([]) // kill me ≠ kill myself
    expect(checkCrisisSignal("i'm dying to see you")).toEqual([])
    expect(checkCrisisSignal("she said she would kill me if i was late")).toEqual([])
    expect(checkCrisisSignal('i\'m better off without them')).toEqual([])
  })

  it('ignores self-harm keywords in physical / hygiene contexts', () => {
    expect(checkCrisisSignal('i cut my hair yesterday')).toEqual([])
    expect(checkCrisisSignal('i cut myself shaving this morning')).toEqual([])
    expect(checkCrisisSignal('i cut myself on glass yesterday')).toEqual([])
    expect(checkCrisisSignal('i cut myself a slice of cake')).toEqual([])
    expect(checkCrisisSignal('i hurt my ankle playing basketball')).toEqual([])
    expect(checkCrisisSignal('i hurt myself at the gym')).toEqual([])
    expect(checkCrisisSignal('i hurt myself carrying boxes, my back is killing me')).toEqual([])
    expect(checkCrisisSignal('i hurt myself playing football')).toEqual([])
    expect(checkCrisisSignal('the bleeding is normal after surgery')).toEqual([])
    expect(checkCrisisSignal('the company is bleeding out')).toEqual([])
  })

  it('ignores benign overdose / substance-lite hyperbole', () => {
    expect(checkCrisisSignal('i overdosed on coffee today')).toEqual([])
    expect(checkCrisisSignal('overdosing on chocolate')).toEqual([])
  })

  it('ignores bare "suicide" in prevention / education / sports-idiom contexts', () => {
    expect(checkCrisisSignal('the suicide hotline is 988')).toEqual([])
    expect(checkCrisisSignal('we studied suicide prevention in class')).toEqual([])
    expect(checkCrisisSignal('suicide awareness month is coming up')).toEqual([])
  })

  it('ignores vanish/disappear directed at platforms rather than self', () => {
    expect(checkCrisisSignal('i want to disappear from instagram')).toEqual([])
    expect(checkCrisisSignal('i want to disappear off social media for a while')).toEqual([])
  })

  it('ignores "want to die" / "kms" as dark hyperbole, but not real kms', () => {
    expect(checkCrisisSignal('i want to die laughing')).toEqual([])
    expect(checkCrisisSignal('this exam is going to make me kms lol')).toEqual([])
    expect(checkCrisisSignal('it\'s just a joke, i want to die lol')).toEqual([])
    expect(checkCrisisSignal('ran 5 kms today')).toEqual([]) // distance, not intent
  })

  it('ignores "can\'t go on" tied to a trip / activity', () => {
    expect(checkCrisisSignal('i can\'t go on this hike with this knee')).toEqual([])
    expect(checkCrisisSignal('can\'t carry on this game anymore')).toEqual([])
    expect(checkCrisisSignal('we can\'t go on this trip')).toEqual([])
    expect(checkCrisisSignal('i can\'t keep going to the gym')).toEqual([])
  })

  it('ignores idioms and benign-leaving contexts from the review', () => {
    expect(checkCrisisSignal('i shoot myself in the foot every time')).toEqual([])
    expect(checkCrisisSignal('jumped off the bridge into the lake for fun with friends')).toEqual([])
    expect(checkCrisisSignal('i wrote a farewell letter when i quit the job')).toEqual([])
    expect(checkCrisisSignal("i don't want to live in the city anymore")).toEqual([])
    // "that's just a joke" is a real disavowal — the intent is disclaimed.
    expect(checkCrisisSignal("i want to die, that's just a joke")).toEqual([])
  })
})

describe('checkCrisisSignal — non-string input coercion', () => {
  it('never throws and returns [] for nullish / non-string input', () => {
    expect(() => checkCrisisSignal(null as unknown as string)).not.toThrow()
    expect(() => checkCrisisSignal(undefined as unknown as string)).not.toThrow()
    expect(checkCrisisSignal(null as unknown as string)).toEqual([])
    expect(checkCrisisSignal(undefined as unknown as string)).toEqual([])
    expect(checkCrisisSignal(42 as unknown as string)).toEqual([])
  })
})

describe('checkCrisisSignal — combination logic', () => {
  it('returns every distinct tripped rule', () => {
    const matches = checkCrisisSignal('i want to die. i wrote a goodbye note.')
    expect(labelsOf(matches)).toEqual(
      expect.arrayContaining(['want to die', 'goodbye note']),
    )
    expect(matches).toHaveLength(2)
  })

  it('reports a single match per rule even if the phrase repeats', () => {
    const matches = checkCrisisSignal('i want to die. i want to die.')
    expect(matches).toHaveLength(1)
    expect(matches[0].pattern).toBe('want to die')
  })

  it('orders matches by matchedAt ascending', () => {
    // "goodbye" appears before the later "want to die" in this sentence.
    const matches = checkCrisisSignal('i wrote a goodbye note and now i want to die')
    expect(labelsOf(matches)).toEqual(['goodbye note', 'want to die'])
    expect(matches[0].matchedAt).toBeLessThan(matches[1].matchedAt)
  })
})

describe('checkCrisisSignal — empty and short input', () => {
  it('returns nothing for empty / whitespace / trivial input', () => {
    expect(checkCrisisSignal('')).toEqual([])
    expect(checkCrisisSignal('   ')).toEqual([])
    expect(checkCrisisSignal('a')).toEqual([])
    expect(checkCrisisSignal('just a normal day')).toEqual([])
  })
})

describe('checkCrisisSignal — unicode and case handling', () => {
  it('is case-insensitive', () => {
    expect(labelsOf(checkCrisisSignal('I WANT TO DIE'))).toContain('want to die')
  })

  it('folds smart quotes and dashes so phrases still match', () => {
    const matches = checkCrisisSignal('I’m so tired — I want to DIE.')
    expect(labelsOf(matches)).toContain('want to die')
    expect(matches[0].matchedAt).toBe(normalisedOf('I’m so tired — I want to DIE.').indexOf('want to die'))
  })

  it('still matches text that is mostly unicode / non-latin', () => {
    expect(labelsOf(checkCrisisSignal('je suis fatigué, i want to die'))).toContain('want to die')
    expect(labelsOf(checkCrisisSignal('😞 i want to die 😞'))).toContain('want to die')
  })

  it('documents the cheap-normalisation boundary: diacritic typos do not trip', () => {
    // Beyond the "lowercase + trim + whitespace" promise; noted limitation.
    expect(checkCrisisSignal('i want to dïe')).toEqual([])
  })
})

describe('checkCrisisSignal — determinism', () => {
  it('returns identical output for identical input, with index into normalised text', () => {
    const input = 'I AM GOING TO KILL MYSELF TONIGHT — i wrote a goodbye note.'
    const first = checkCrisisSignal(input)
    const second = checkCrisisSignal(input)

    expect(first).toEqual(second)
    expect(first[0].matchedAt).toBe(normalisedOf(input).indexOf('kill myself'))
  })
})

describe('checkCrisisSignal — round-3 review regressions', () => {
  it('trips on negated kidding, but not on actual kidding (finding 1)', () => {
    expect(labelsOf(checkCrisisSignal("i want to die, i'm not just kidding"))).toContain('want to die')
    expect(labelsOf(checkCrisisSignal("i want to die, i'm not only kidding"))).toContain('want to die')
    expect(checkCrisisSignal('i want to die, just kidding')).toEqual([])
    expect(checkCrisisSignal('i was only kidding about how i feel')).toEqual([])
  })

  it('nobody-rule requires a self-anchor or an if/when clause (finding 2)', () => {
    expect(labelsOf(checkCrisisSignal('nobody would miss me'))).toContain('nobody would miss me')
    expect(labelsOf(checkCrisisSignal('no one will notice me'))).toContain('nobody would miss me')
    expect(labelsOf(checkCrisisSignal('nobody would even notice if i was gone'))).toContain(
      'nobody would miss me',
    )
    expect(checkCrisisSignal('nobody cares')).toEqual([])
    expect(checkCrisisSignal('no one will notice my haircut')).toEqual([])
    expect(checkCrisisSignal('nobody misses the old site')).toEqual([])
  })

  it('suppresses explicitly-negated first-person phrases, keeps non-immediate ones (finding 4)', () => {
    expect(checkCrisisSignal("i don't want to die")).toEqual([])
    expect(checkCrisisSignal("i won't kill myself")).toEqual([])
    expect(checkCrisisSignal("i didn't cut myself")).toEqual([])
    expect(labelsOf(checkCrisisSignal('i want to die'))).toContain('want to die')
    // The wake-up rule is not negation-suppressed, so this still trips.
    expect(labelsOf(checkCrisisSignal('sometimes i still don\'t want to wake up'))).toContain(
      "don't want to wake up",
    )
  })

  it('keeps new benign schedule / location / news readings inert (finding 5)', () => {
    expect(checkCrisisSignal("i don't want to wake up at 6am")).toEqual([])
    expect(checkCrisisSignal("i don't want to wake up for work")).toEqual([])
    expect(checkCrisisSignal('not worth living in this apartment')).toEqual([])
    expect(checkCrisisSignal('the suicide bomb attack was all over the news')).toEqual([])
    expect(checkCrisisSignal('the suicide squad movie is just fun')).toEqual([])
  })

  it('still trips on prior must-trip cases after the Safari-safe refactor', () => {
    expect(labelsOf(checkCrisisSignal('my grandma is dying and i want to die'))).toContain('want to die')
    expect(labelsOf(checkCrisisSignal("this isn't a joke, i want to die"))).toContain('want to die')
    expect(labelsOf(checkCrisisSignal("everyone's laughing at me, i want to die"))).toContain('want to die')
    expect(labelsOf(checkCrisisSignal('i cut my wrists with glass'))).toContain('cut myself')
    expect(labelsOf(checkCrisisSignal("i can't go on any further"))).toContain("can't go on")
    expect(labelsOf(checkCrisisSignal('sometimes i just want to kms'))).toContain('kill myself')
  })
})

describe('checkCrisisSignal — round-4 review regressions', () => {
  it('"not worth living" only suppressed by true places (finding 1)', () => {
    expect(checkCrisisSignal('not worth living in this apartment')).toEqual([]) // inert
    expect(checkCrisisSignal('not worth living there')).toEqual([]) // inert
    expect(labelsOf(checkCrisisSignal('life is not worth living at all'))).toContain('not worth living')
    expect(labelsOf(checkCrisisSignal('not worth living with this pain'))).toContain('not worth living')
  })

  it('nobody-rule accepts ever and place-style qualifiers (finding 2)', () => {
    expect(labelsOf(checkCrisisSignal('nobody would miss me'))).toContain('nobody would miss me')
    expect(labelsOf(checkCrisisSignal('no one will ever miss me'))).toContain('nobody would miss me')
    expect(labelsOf(checkCrisisSignal('nobody in the world would miss me'))).toContain('nobody would miss me')
    expect(labelsOf(checkCrisisSignal('nobody at all would miss me'))).toContain('nobody would miss me')
    expect(labelsOf(checkCrisisSignal('no one out there would miss me'))).toContain('nobody would miss me')
    expect(labelsOf(checkCrisisSignal('nobody anywhere would miss me'))).toContain('nobody would miss me')
    // self-anchor / if-when requirement still holds
    expect(checkCrisisSignal('nobody misses the old site')).toEqual([])
    expect(checkCrisisSignal('no one will notice my haircut')).toEqual([])
    expect(checkCrisisSignal('nobody would miss the open goal')).toEqual([])
  })
})
