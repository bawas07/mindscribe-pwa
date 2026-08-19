import { beforeEach, describe, expect, it } from 'vitest'
import { createDeviceKeyIn, decryptText, encryptText, getOrCreateDeviceKey } from '../crypto'
import { db, MindScribeDb, type Entry } from '../schema'

const IV_LENGTH_BYTES = 12

/** Pure test key, independent of the persistence path under test. */
function generateTestKey(): Promise<CryptoKey> {
  return globalThis.crypto.subtle.generateKey(
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  )
}

beforeEach(async () => {
  // Clean slate per test; clearing tables keeps the same Dexie/IndexedDB
  // instance open (db.delete() would close it and block auto-reopen).
  await Promise.all(db.tables.map((table) => table.clear()))
})

describe('encryptText / decryptText', () => {
  it('round-trips unicode and long text', async () => {
    const key = await generateTestKey()
    const original = 'Héllo 👋 — 日本語、emoji 🎉\n' + 'A quiet reflection. '.repeat(3000) + 'fin.'
    const blob = await encryptText(key, original)

    expect(blob.byteLength).toBeGreaterThan(IV_LENGTH_BYTES)
    await expect(decryptText(key, blob)).resolves.toBe(original)
  })

  it('rejects tampered ciphertext with a descriptive error', async () => {
    const key = await generateTestKey()
    const blob = await encryptText(key, 'a private thought')

    const tampered = new Uint8Array(blob.slice(0))
    tampered[IV_LENGTH_BYTES] ^= 0xff // first ciphertext byte

    await expect(decryptText(key, tampered.buffer)).rejects.toThrow(
      /corrupt|tampered|different key/,
    )
  })

  it('rejects decryption with the wrong key instead of returning garbage', async () => {
    const keyA = await generateTestKey()
    const keyB = await generateTestKey()
    const blob = await encryptText(keyA, 'locked to key A')

    await expect(decryptText(keyB, blob)).rejects.toThrow(/corrupt|tampered|different key/)
  })

  it('uses a fresh random IV for every encryption', async () => {
    const key = await generateTestKey()
    const text = 'the same text, twice'

    const first = await encryptText(key, text)
    const second = await encryptText(key, text)

    expect(new Uint8Array(first, 0, IV_LENGTH_BYTES)).not.toEqual(
      new Uint8Array(second, 0, IV_LENGTH_BYTES),
    )
    expect(new Uint8Array(first)).not.toEqual(new Uint8Array(second))
  })

  it('persists the encrypted blob and decrypts it after an IndexedDB roundtrip', async () => {
    const key = await generateTestKey()
    const entry: Entry = {
      id: 'entry-persist',
      createdAt: '2025-01-15T08:30:00.000Z',
      contentEncrypted: await encryptText(key, 'what I wrote today'),
      moodEmoji: '😌',
      hasFollowup: false,
    }

    await db.entries.put(entry)
    const loaded = await db.entries.get(entry.id)
    expect(loaded).toBeDefined()

    await expect(decryptText(key, loaded!.contentEncrypted)).resolves.toBe('what I wrote today')
  })
})

describe('getOrCreateDeviceKey / createDeviceKeyIn', () => {
  it('generates a non-extractable key once and reuses it', async () => {
    const first = await getOrCreateDeviceKey()
    const second = await getOrCreateDeviceKey()

    expect(first.extractable).toBe(false)
    expect(second.extractable).toBe(false)
    expect(await db.secrets.count()).toBe(1)

    // Non-extractable keys can't be exported for comparison; prove the
    // read-back key is the same one by decrypting across the pair.
    const blob = await encryptText(first, 'cross-key check')
    await expect(decryptText(second, blob)).resolves.toBe('cross-key check')
  })

  it('hands the same key to concurrent callers in one tab', async () => {
    const [first, second] = await Promise.all([
      getOrCreateDeviceKey(),
      getOrCreateDeviceKey(),
    ])

    const blob = await encryptText(first, 'concurrent call')
    await expect(decryptText(second, blob)).resolves.toBe('concurrent call')
    expect(await db.secrets.count()).toBe(1)
  })

  it('adopts the winner key when two connections race on first launch', async () => {
    const firstConnection = new MindScribeDb()
    const secondConnection = new MindScribeDb()

    const [first, second] = await Promise.all([
      createDeviceKeyIn(firstConnection),
      createDeviceKeyIn(secondConnection),
    ])

    expect(first.extractable).toBe(false)
    expect(second.extractable).toBe(false)
    const blob = await encryptText(first, 'one key, two connections')
    await expect(decryptText(second, blob)).resolves.toBe('one key, two connections')
    expect(await firstConnection.secrets.count()).toBe(1)

    firstConnection.close()
    secondConnection.close()
  })
})
