/**
 * Shared vitest setup.
 *
 * IndexedDB is not implemented in jsdom, so every suite runs against
 * fake-indexeddb (in-memory, structured-clone faithful). Web Crypto
 * needs no polyfill: Node >= 20 exposes globalThis.crypto.subtle,
 * which vitest's jsdom environment already provides.
 */
import 'fake-indexeddb/auto'
