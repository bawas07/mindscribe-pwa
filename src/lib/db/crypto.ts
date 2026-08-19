/**
 * Web Crypto layer for at-rest encryption.
 *
 * M1 ships the device-key path only (plan decision D3/T5): a single
 * non-extractable AES-GCM 256 key, generated once on first use and
 * persisted in the `secrets` table. At-rest encryption is always on;
 * the PIN/KDF path lands in M1.1 and export protection in Phase 2
 * (see docs/architecture.md).
 *
 * Encrypted values are stored as a single blob: 12-byte IV ‖ ciphertext.
 * The IV travels fused to its ciphertext so it can never be persisted
 * separately and lost, which would make the row undecryptable.
 */
import { db, DEVICE_KEY_ROW_ID, type MindScribeDb } from './schema'

const AES_GCM_ALGORITHM = 'AES-GCM'
const DEVICE_KEY_LENGTH_BITS = 256
const IV_LENGTH_BYTES = 12

// In-tab memo for the in-flight load so concurrent callers in one tab
// share a single load. Cleared once it settles; later calls re-read
// the secrets table. Cross-tab races are closed by the transaction in
// createDeviceKeyIn: IndexedDB serializes overlapping readwrite
// transactions, so a losing connection re-reads the winner's row.
let inFlightDeviceKey: Promise<CryptoKey> | null = null

/**
 * Transactional device-key load/create on a given database connection.
 * The check-put sequence runs inside one readwrite transaction on
 * `secrets`; key generation happens outside it (native promises must
 * not be awaited inside a Dexie transaction). If two connections race
 * on first launch (two tabs), IndexedDB serializes their readwrite
 * transactions, so the loser's in-transaction re-read finds the
 * winner's committed key and adopts it — instead of generating a
 * second key that would orphan the other tab's data.
 */
export async function createDeviceKeyIn(dbInstance: MindScribeDb): Promise<CryptoKey> {
  const existing = await dbInstance.secrets.get(DEVICE_KEY_ROW_ID)
  if (existing) return existing.key

  const freshKey = await globalThis.crypto.subtle.generateKey(
    { name: AES_GCM_ALGORITHM, length: DEVICE_KEY_LENGTH_BITS },
    false, // non-extractable: key material never leaves this device
    ['encrypt', 'decrypt'],
  )

  return dbInstance.transaction('rw', dbInstance.secrets, async () => {
    // Re-check inside the transaction: another connection may have won
    // the race while we were generating; adopt its key instead.
    const winner = await dbInstance.secrets.get(DEVICE_KEY_ROW_ID)
    if (winner) return winner.key

    await dbInstance.secrets.put({ id: DEVICE_KEY_ROW_ID, key: freshKey })
    return freshKey
  })
}

export async function getOrCreateDeviceKey(): Promise<CryptoKey> {
  inFlightDeviceKey ??= createDeviceKeyIn(db)
  try {
    return await inFlightDeviceKey
  } finally {
    inFlightDeviceKey = null
  }
}

/**
 * Encrypts text as a single blob: 12-byte IV ‖ AES-GCM ciphertext,
 * with a fresh random IV per call. Returned ArrayBuffer is what gets
 * stored in the encrypted columns (contentEncrypted etc.).
 */
export async function encryptText(key: CryptoKey, plaintext: string): Promise<ArrayBuffer> {
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(IV_LENGTH_BYTES))
  const ciphertext = await globalThis.crypto.subtle.encrypt(
    { name: AES_GCM_ALGORITHM, iv },
    key,
    new TextEncoder().encode(plaintext),
  )

  const envelope = new Uint8Array(IV_LENGTH_BYTES + ciphertext.byteLength)
  envelope.set(iv, 0)
  envelope.set(new Uint8Array(ciphertext), IV_LENGTH_BYTES)
  return envelope.buffer
}

export async function decryptText(key: CryptoKey, blob: ArrayBuffer): Promise<string> {
  try {
    if (blob.byteLength <= IV_LENGTH_BYTES) {
      throw new Error(`encrypted blob is too short (${blob.byteLength} bytes) to hold an IV`)
    }
    const iv = new Uint8Array(blob, 0, IV_LENGTH_BYTES)
    const ciphertext = new Uint8Array(blob, IV_LENGTH_BYTES)
    const plaintext = await globalThis.crypto.subtle.decrypt(
      { name: AES_GCM_ALGORITHM, iv },
      key,
      ciphertext,
    )
    return new TextDecoder().decode(plaintext)
  } catch (error) {
    throw new Error(
      'Decryption failed: the data is corrupt, was tampered with, or was encrypted with a different key',
      { cause: error },
    )
  }
}
