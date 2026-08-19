import { beforeEach, describe, expect, it } from 'vitest'
import { decryptText, getOrCreateDeviceKey } from '../db/crypto'
import { db, type Entry } from '../db/schema'
import { countEntries, createEntry, listRecentEntries } from '../entries'

beforeEach(async () => {
  // Clean slate per test; same pattern as the other db suites.
  await Promise.all(db.tables.map((table) => table.clear()))
})

describe('createEntry (W6b write side — plaintext in, encrypted out)', () => {
  it('writes the row with encrypted content, a UUID id and today\'s createdAt', async () => {
    const id = await createEntry({ content: 'Spent the morning stuck on the call-graph traversal.', moodEmoji: '🙂' })

    const row = (await db.entries.get(id)) as Entry
    expect(row).toBeDefined()
    expect(row.id).toBe(id)
    expect(id).toMatch(/^[0-9a-f-]{36}$/)
    expect(row.moodEmoji).toBe('🙂')
    expect(row.hasFollowup).toBe(false)
    expect(Number.isNaN(Date.parse(row.createdAt))).toBe(false)
  })

  it('encrypts at rest: the stored blob is a non-empty ArrayBuffer whose plaintext is NOT the input', async () => {
    const plaintext = 'i want to kill myself tonight' // tripped or not, it must never persist raw
    const id = await createEntry({ content: plaintext, moodEmoji: '😔' })

    const row = (await db.entries.get(id)) as Entry
    // fake-indexeddb round-trips stored blobs through its own realm, so
    // `instanceof ArrayBuffer` is unreliable in tests (real IndexedDB
    // returns a genuine ArrayBuffer). Assert on shape + decryptability.
    expect(Object.prototype.toString.call(row.contentEncrypted)).toBe('[object ArrayBuffer]')
    expect(row.contentEncrypted.byteLength).toBeGreaterThan(12) // 12-byte IV + ciphertext

    const storedAsText = new TextDecoder().decode(new Uint8Array(row.contentEncrypted))
    expect(storedAsText).not.toContain('kill myself')
    expect(storedAsText).not.toContain(plaintext)

    // And the device key round-trips it back to exactly what was saved.
    const key = await getOrCreateDeviceKey()
    expect(await decryptText(key, row.contentEncrypted)).toBe(plaintext)
  })

  it('trims surrounding whitespace before encrypting (stored content is the trimmed text)', async () => {
    const id = await createEntry({ content: '  \n  A quiet evening walk.  \n ', moodEmoji: '😌' })

    const key = await getOrCreateDeviceKey()
    const row = (await db.entries.get(id)) as Entry
    expect(await decryptText(key, row.contentEncrypted)).toBe('A quiet evening walk.')
  })

  it('is readable through the read side immediately (createdAt indexed, listRecentEntries works)', async () => {
    const id = await createEntry({ content: 'First saved entry', moodEmoji: '😐' })
    await createEntry({ content: 'Second saved entry', moodEmoji: '🙂' })

    const recent = await listRecentEntries()
    expect(recent.map((entry) => entry.id)).toContain(id)
    expect(recent[0].content).toBe('Second saved entry')
    expect(recent.every((entry) => !('contentEncrypted' in entry))).toBe(true)
  })

  it('is the only writer: rows created here never expose a plaintext column', async () => {
    const id = await createEntry({ content: 'no plaintext column may exist', moodEmoji: '' })

    const row = await db.entries.get(id)
    const columns = Object.keys(row as Entry)
    expect(columns).not.toContain('content')
    expect(columns).not.toContain('text')
  })

  it('rejects empty or whitespace-only content with a clear error', async () => {
    await expect(createEntry({ content: '', moodEmoji: '🙂' })).rejects.toThrow('Cannot save an empty entry')
    await expect(createEntry({ content: '   \n\t  ', moodEmoji: '🙂' })).rejects.toThrow('Cannot save an empty entry')
    expect(await countEntries()).toBe(0)
  })
})

describe('countEntries (stuck-prompt seed, decision T8)', () => {
  it('starts at 0 and counts saved entries', async () => {
    expect(await countEntries()).toBe(0)
    await createEntry({ content: 'one', moodEmoji: '🙂' })
    await createEntry({ content: 'two', moodEmoji: '😔' })
    expect(await countEntries()).toBe(2)
  })
})