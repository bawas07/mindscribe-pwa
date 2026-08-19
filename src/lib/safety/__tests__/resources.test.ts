import { describe, expect, it } from 'vitest'
import { CRISIS_RESOURCES, getCrisisResource } from '../resources'

describe('CRISIS_RESOURCES (W6a default list)', () => {
  it('is non-empty and gives the panel enough to render', () => {
    expect(CRISIS_RESOURCES.length).toBeGreaterThanOrEqual(3)
  })

  it('has unique ids', () => {
    const ids = CRISIS_RESOURCES.map((resource) => resource.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('has a name and a note on every entry (the copy the UI shows)', () => {
    for (const resource of CRISIS_RESOURCES) {
      expect(resource.id.trim().length).toBeGreaterThan(0)
      expect(resource.name.trim().length).toBeGreaterThan(0)
      expect(resource.note.trim().length).toBeGreaterThan(0)
    }
  })

  it('keeps reachable-by-phone entries for most resources (directory entry aside)', () => {
    const withPhone = CRISIS_RESOURCES.filter((resource) => resource.phone.trim().length > 0)
    expect(withPhone.length).toBeGreaterThanOrEqual(3)
  })
})

describe('getCrisisResource', () => {
  it('looks up a known id (US 988) and returns the entry', () => {
    const resource = getCrisisResource('us-988')
    expect(resource).toBeDefined()
    expect(resource?.phone).toBe('988')
  })

  it('returns undefined for an unknown id', () => {
    expect(getCrisisResource('not-a-real-id')).toBeUndefined()
  })
})
