# MindScribe (Reflective Journal PWA) — Data Schema

All data lives in IndexedDB (via Dexie.js), on-device only. No server, no remote schema. Diagram uses `erDiagram` for clarity even though the underlying store is IndexedDB, not SQL.

## Entity relationships

```mermaid
erDiagram
    ENTRY ||--o{ FOLLOWUP_RESPONSE : "may have"
    ENTRY }o--|| ROLLING_SUMMARY : "informs (aggregate, not FK)"
    SETTINGS ||--|| APP : "single row"

    ENTRY {
        string id PK
        string created_at
        blob content_encrypted
        string mood_emoji
        boolean has_followup
    }
    FOLLOWUP_RESPONSE {
        string id PK
        string entry_id FK
        blob question_encrypted
        blob response_encrypted
    }
    ROLLING_SUMMARY {
        string id PK
        string generated_at
        blob themes_encrypted
        string source_entry_count
    }
    SETTINGS {
        string id PK
        boolean pin_enabled
        string reminder_time
        string reminder_mode
        string last_export_at
        string model_version
    }
```

Note: `ROLLING_SUMMARY` is a derived aggregate, not linked to individual entries via foreign key — there's no clean per-entry provenance to track, which is why entry deletion triggers a full regeneration rather than a targeted removal (see Architecture doc).

## Entities

### Entry
| Field | Type | Notes |
|---|---|---|
| id | string (uuid) | PK |
| created_at | ISO timestamp | plaintext — needed for calendar queries without decrypting every entry |
| content_encrypted | blob | AES-GCM encrypted entry text |
| mood_emoji | string | plaintext — user-selected, used for calendar display; not sensitive enough to require decryption just to render the dashboard |
| has_followup | boolean | plaintext — flags whether a FollowupResponse exists, for UI purposes |

### FollowupResponse
| Field | Type | Notes |
|---|---|---|
| id | string (uuid) | PK |
| entry_id | string (uuid) | FK → Entry |
| question_encrypted | blob | the model's follow-up question, encrypted |
| response_encrypted | blob | user's response, encrypted, appended context to the entry |

### RollingSummary
| Field | Type | Notes |
|---|---|---|
| id | string (uuid) | PK — typically only one active row, but versioned for regeneration history if useful |
| generated_at | ISO timestamp | plaintext |
| themes_encrypted | blob | encrypted structured list: `[{ topic, last_mentioned_days_ago, mention_count }]` |
| source_entry_count | number | plaintext — how many entries this summary was generated from, useful for debugging/regeneration logic |

### Settings
| Field | Type | Notes |
|---|---|---|
| id | string | PK, single row |
| pin_enabled | boolean | plaintext |
| reminder_time | string (HH:mm) | plaintext, optional |
| reminder_mode | enum | `start_of_day` \| `end_of_day` \| `off` |
| last_export_at | ISO timestamp | plaintext, optional |
| model_version | string | tracks which model/quant version is loaded, for future migration handling |

## What's encrypted vs plaintext, and why

- **Encrypted**: entry content, follow-up Q&A, rolling summary theme content — anything that reveals what the user actually wrote or thought about
- **Plaintext**: timestamps, mood emoji, boolean flags, settings values — needed for dashboard rendering (calendar markers, mood display) without a full decrypt pass on every entry just to draw the calendar. None of these leak entry *content* on their own.

## Open questions / TODO

- Whether `mood_emoji` being plaintext is an acceptable tradeoff long-term, or whether a future version should encrypt it too and accept the decrypt cost for calendar rendering — flagged as a deliberate v1 simplification, not a final answer
- Migration strategy if the Entry schema changes after users already have local data (IndexedDB schema versioning via Dexie's built-in versioning should cover this, but not yet designed in detail)
