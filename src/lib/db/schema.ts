/**
 * Dexie database schema. Versioned from day one (plan risk R6) so any
 * future shape change is an explicit migration, not a retrofit.
 *
 * v1 tables per docs/data-schema.md:
 * - entries / followupResponses / rollingSummary / settings (domain data)
 * - secrets (internal: single row holding the device encryption key)
 *
 * Plaintext is limited to what the dashboard needs to render without
 * decrypting (timestamps, mood, flags, settings). Entry content,
 * follow-up Q&A and summary themes are always encrypted at rest —
 * there is deliberately no unencrypted content column.
 */
import Dexie, { type EntityTable } from 'dexie'

export interface Entry {
  id: string
  /** ISO timestamp, plaintext — indexed; the calendar range-queries it per month. */
  createdAt: string
  /** AES-GCM encrypted entry text as a single blob: 12-byte IV ‖ ciphertext (see crypto.ts). */
  contentEncrypted: ArrayBuffer
  moodEmoji: string
  hasFollowup: boolean
}

export interface FollowupResponse {
  id: string
  /** FK → Entry.id, indexed for cascade reads/deletes. */
  entryId: string
  /** Encrypted blob: 12-byte IV ‖ ciphertext (see crypto.ts). */
  questionEncrypted: ArrayBuffer
  /** Encrypted blob: 12-byte IV ‖ ciphertext (see crypto.ts). */
  responseEncrypted: ArrayBuffer
  /** Ids of entries the question was grounded in (plaintext, for swipe-peek). */
  referencedEntryIds: string[]
  /**
   * Plaintext convenience timestamp (W10) for inline Q1→Q2 ordering. Not
   * indexed — listFollowupsForEntry sorts in JS — so no schema migration is
   * needed and pre-existing rows stay valid. Optional by design.
   */
  createdAt?: string
}

export interface RollingSummary {
  id: string
  generatedAt: string
  /** Encrypted themes blob: 12-byte IV ‖ ciphertext (see crypto.ts). */
  themesEncrypted: ArrayBuffer
  sourceEntryCount: number
}

export interface Settings {
  id: string
  pinEnabled: boolean
  /** W4 onboarding gate (plan decision T6): first-open flag, plaintext, default false. */
  onboardingCompleted: boolean
  /** HH:mm, plaintext, optional. */
  reminderTime: string | null
  reminderMode: 'start_of_day' | 'end_of_day' | 'off'
  lastExportAt: string | null
  modelVersion: string | null
}

/** Internal: single-row table holding the device encryption key. */
export interface DeviceKeyRow {
  id: string
  key: CryptoKey
}

/** Settings is a single row (plan decision T6: onboarding flag lives here). */
export const SETTINGS_ROW_ID = 'app'

/** Rolling summary is a single row (W11 upserts one current summary). */
export const ROLLING_SUMMARY_ROW_ID = 'rollingSummary'

/** Secrets is a single row holding the device key (see crypto.ts). */
export const DEVICE_KEY_ROW_ID = 'deviceKey'

export class MindScribeDb extends Dexie {
  entries!: EntityTable<Entry, 'id'>
  followupResponses!: EntityTable<FollowupResponse, 'id'>
  rollingSummary!: EntityTable<RollingSummary, 'id'>
  settings!: EntityTable<Settings, 'id'>
  secrets!: EntityTable<DeviceKeyRow, 'id'>

  constructor() {
    super('mindscribe')
    this.version(1).stores({
      entries: 'id, createdAt',
      followupResponses: 'id, entryId',
      rollingSummary: 'id',
      settings: 'id',
      secrets: 'id',
    })
  }
}

export const db = new MindScribeDb()
