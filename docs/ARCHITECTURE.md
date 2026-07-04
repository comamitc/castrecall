# CastRecall architecture

## Design stance

CastRecall is a **private ingestion and curation loop**, not a podcast app.
Three invariants shape everything:

1. **Read-only against Pocket Casts.** No playback mutation tools exist in v0.
2. **Transcripts are source material, not memory.** Full transcripts are stored
   privately with provenance; only approval-gated review candidates are offered
   to the human. The plugin never writes to durable OpenClaw memory.
3. **No fake fallbacks.** Every rung of the transcript ladder either produces a
   real transcript or reports exactly why it missed, failed, or was skipped.

## Module map

```
src/
├── index.ts               # OpenClaw plugin entry: defineToolPlugin + 5 tools
├── tools.ts               # Tool implementations, pure over (config, params, deps)
├── config.ts              # Env-first config resolution; secrets never in plugin config
├── storage.ts             # Data dir layout, state.json, idempotent writes
├── review.ts              # Review-candidate markdown generation (heuristic excerpts)
├── resolver.ts            # Pocket Casts listen → RSS feed URL → feed item + transcript links
├── pocketcasts/
│   └── client.ts          # Read-only unofficial API adapter (login + history)
└── transcripts/
    ├── ladder.ts          # Orchestrates the three rungs, collects outcomes
    ├── rss.ts             # Rung 1: <podcast:transcript> fetch, format preference
    ├── taddy.ts           # Rung 2: Taddy GraphQL (optional)
    ├── stt.ts             # Rung 3: AssemblyAI / OpenAI (optional, gated, paid)
    └── normalize.ts       # VTT/SRT/JSON/HTML/plain → normalized text + segments
```

Everything except `index.ts` is runtime-agnostic: tools take a resolved config
and injectable `fetch`/clock, which is how the test suite exercises the full
sync → fetch → review flow without network access.

## Data flow

```
Pocket Casts history (unofficial API, read-only)
        │  castrecall_sync_history
        ▼
state.json (seen episode UUIDs, timestamps, transcript status)
        │  castrecall_fetch_transcript
        ▼
Transcript ladder: RSS <podcast:transcript> → Taddy → STT (explicitly enabled)
        │
        ▼
sources/<uuid>/{raw.<ext>, transcript.txt, provenance.json}   ← private source lane
        │  castrecall_generate_review
        ▼
review/pending/<uuid>.md   ← approval gate; human promotes (or deletes) manually
```

## Episode resolution

Pocket Casts history gives `podcastUuid` + episode audio URL/title, not the RSS
feed. Feed URL resolution tries, in order:

1. `refresh.pocketcasts.com/import/export_feed_urls` — the unauthenticated
   endpoint community export tools use (unofficial, brittle).
2. iTunes Search API matched by podcast title (official, fuzzy).

Feed items are matched by enclosure URL (query-stripped), then GUID, then
normalized title.

## Known risks and their handling

| Risk | Handling |
| --- | --- |
| Unofficial Pocket Casts API breaks | Isolated in `pocketcasts/client.ts`; errors say explicitly the API shape may have changed. Documented in README. |
| Credential exposure | Env-only, never logged or included in errors; `setup_status` reports booleans only. |
| Copyrighted transcripts | Stored as `privacyClass: private-source`; excerpt-only review candidates; README documents intended private use. |
| Noisy over-ingestion | Approval gate; review candidates are write-once; excerpts are capped (5 × 600 chars). |
| STT cost surprises | Off by default; requires explicit `CASTRECALL_ENABLE_STT=true` plus a provider key; every skip says why. |
| Path traversal via hostile UUIDs | `safeName()` sanitizes all path components (tested). |

## Future rungs / ideas (not in v0)

- Local speech-to-text (whisper.cpp / faster-whisper) as a free, private STT rung.
- Podcast Index API as an additional feed/transcript resolver.
- More platforms (Spotify, Apple Podcasts) behind the same `ListenRecord` model.
- An approval tool that moves a reviewed candidate into a user-designated notes
  directory (still never directly into OpenClaw memory).
