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
├── index.ts               # OpenClaw plugin entry: defineToolPlugin + 6 tools
├── tools.ts               # Tool implementations, pure over (config, params, deps)
├── pipeline.ts            # castrecall_run_pipeline: sync → transcript → review, locked + cooldown-gated
├── config.ts              # Env-first config resolution; secrets never in plugin config
├── storage.ts             # Data dir layout, state.json, idempotent writes, pipeline lock + sync backoff
├── review.ts              # Review-candidate markdown generation (heuristic excerpts)
├── corpus-export.ts       # Opt-in export: section-split, frontmattered markdown pages (gbrain, etc.)
├── resolver.ts            # Pocket Casts listen → RSS feed URL → feed item + transcript links
├── pocketcasts/
│   └── client.ts          # Read-only unofficial API adapter (login + history)
└── transcripts/
    ├── ladder.ts          # Orchestrates the four rungs, collects outcomes
    ├── rss.ts             # Rung 1: <podcast:transcript> fetch, format preference
    ├── taddy.ts           # Rung 2: Taddy GraphQL (optional)
    ├── local-whisper.ts   # Rung 3: detected local Whisper CLI (free, private)
    ├── stt.ts             # Rung 4: AssemblyAI / OpenAI (optional, gated, paid)
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
Transcript ladder: RSS <podcast:transcript> → Taddy → local Whisper (detected) → cloud STT (explicitly enabled)
        │
        ▼
sources/<uuid>/{raw.<ext>, transcript.txt, provenance.json}   ← private source lane
        │  castrecall_generate_review
        ▼
review/pending/<uuid>.md   ← approval gate; human promotes (or deletes) manually
```

If `CASTRECALL_EXPORT_DIR` is set, `castrecall_fetch_transcript` also projects
the same source lane out to markdown pages, independently of the review gate:

```
sources/<uuid>/{transcript.txt, provenance.json}
        │  castrecall_fetch_transcript (CASTRECALL_EXPORT_DIR set)
        ▼
<export-dir>/podcasts/<show-slug>/<episode-slug>/*.md   ← markdown pages (gbrain, etc. — see README)
```

### Periodic sync: `castrecall_run_pipeline`

`pipeline.ts` composes the same three tools above (`syncHistory` →
`fetchTranscript` → `generateReview`) into one chained call so a host
scheduler (OpenClaw cron/heartbeat, or OS cron — see README "Scheduled /
periodic sync") can drive the whole loop with no human input. Two properties
make that safe to run on an interval:

- **Lock.** `acquirePipelineLock`/`releasePipelineLock` exclusive-create
  `.staging/pipeline.lock` (same idiom as `storeTranscript`'s staging
  directory below) so two overlapping invocations never both call the
  unofficial Pocket Casts API; a run that can't acquire it returns
  `{ skipped: "locked" }`. A lock older than `LOCK_TTL_MS` is presumed
  abandoned by a crashed run and is reclaimed.
- **Cooldown.** A login/history failure is recorded via
  `recordSyncFailure` with a capped exponential backoff
  (`BACKOFF_BASE_MS` × 2^(failures−1), capped at `BACKOFF_CAP_MS`) stored in
  `state.sync`. A scheduled run inside that window returns
  `{ skipped: "cooldown" }` making zero Pocket Casts calls — the mechanism
  that keeps a scheduler from hammering a down/broken unofficial API. A
  successful login+history resets it immediately via `recordSyncSuccess`,
  before any per-episode transcript work, so a later transcript-ladder
  failure never re-dirties sync health. `force: true` bypasses the cooldown
  (never the lock) for a manual recovery run — see the README warning
  against using it in a scheduler recipe.

Only episodes newly recorded this run get `fetchTranscript`, and only
episodes newly stored this run get `generateReview` — a pre-existing
stored-without-review episode is left for an explicit
`castrecall_generate_review` call, not swept in by the scheduler.

### Corpus export is a projection, not a relocation

`corpus-export.ts` reads only `sources/<uuid>/{transcript.txt, provenance.json}`
and writes section-split, frontmattered markdown pages to a separate,
user-designated directory (`CASTRECALL_EXPORT_DIR`/`exportDir`, off by
default). It deliberately does **not** relocate the data dir into a corpus:
the raw `sources/` layout doesn't match a page-per-section shape, so export is
a bridge, not a redesign. Like review candidates, it structurally cannot read
`review/pending/` or `state.json` — it only ever reads the two source
artifacts a transcript store already produces. Idempotency is keyed off
`contentHash` (see below); a changed hash replaces the whole episode's page
set atomically so no stale section files survive a shorter re-transcription.

## Data dir: versioned machine-readable interface

The data dir (`~/.openclaw/castrecall` by default) is the integration surface
for downstream consumers (corpus exporters, brain pipelines), not just
CastRecall's own state. Its layout is:

```
state.json
sources/<episodeUuid>/
  raw.<ext>
  transcript.txt
  provenance.json
review/pending/<episodeUuid>.md
.staging/          # reserved: in-flight atomic writes + pipeline.lock — consumers must ignore it
```

`.staging/` is CastRecall's private scratch namespace: transcript artifacts are
assembled there and published into `sources/` with a single atomic rename, so
directories CastRecall publishes appear all-at-once, never half-written. The
periodic-sync run lock (`pipeline.lock`) also lives here, exclusive-created
for the same reason. Downstream scans must skip `.staging/` (and any future
dot-prefixed top-level entry).

**Completeness marker:** consumers must treat `transcript.txt` as the marker
that a `sources/<episodeUuid>/` entry is complete. An entry lacking it (for
example, one left behind by a pre-v0.1.0 writer, or external tampering) is
incomplete: skip it. CastRecall itself refuses to treat such directories as
stored — `storeTranscript` surfaces them with an error naming the path so they
can be repaired or removed manually; it never deletes them silently.

### `provenance.json` fields

| Field | Notes |
| --- | --- |
| `platform` | Always `"pocketcasts"` in v0. |
| `podcastTitle`, `episodeTitle` | Display strings, not identifiers. |
| `podcastUuid`, `episodeUuid` | Stable identifiers — see below. |
| `episodeUrl`, `audioUrl`, `feedUrl` | Optional source URLs. |
| `listenTimestamp` | When the episode was first seen synced, if known. |
| `transcriptSource` | `"rss" \| "taddy" \| "local-whisper" \| "stt"`. |
| `transcriptSourceUrl`, `provider` | Optional rung-specific detail. |
| `format` | Raw transcript format (`vtt`, `srt`, `json`, `txt`, ...). |
| `fetchedAt` | ISO timestamp of the fetch that produced this sidecar. |
| `privacyClass` | Always `"private-source"`. |
| `contentHash` | sha256 (hex) of the exact bytes written to `transcript.txt` — the normalized transcript text. Computed once, at first write, so it is stable across re-runs; downstream consumers can key idempotency off it. |
| `schemaVersion` | Data-dir contract version (currently `1`). |

### `state.json` fields

`version` is CastRecall's internal state-format guard (unrelated to the
external contract); `schemaVersion` is the data-dir contract version and is
the field downstream consumers should check. `episodes` maps episode UUID to
a `ListenRecord` (sync/transcript status); `lastSyncAt` is the last successful
sync timestamp.

`sync` (optional, additive) is periodic-sync health, written by
`castrecall_run_pipeline`/`castrecall_sync_history`'s internal cooldown gate:
`consecutiveFailures`, `lastError`/`lastErrorAt` (the most recent login/history
failure reason and when), and `nextEligibleAt` (set only while backing off;
cleared on the next success). `castrecall_setup_status` surfaces this as a
`sync` block, including a derived `inCooldown` boolean — never with secrets.

### Stability guarantees

- **Episode UUID and podcast UUID never change** for a stored item, once
  recorded. `Storage.updateEpisode` enforces this at the storage boundary: it
  re-pins both fields after applying any patch, so no caller — however it
  constructs the patch — can mutate them.
- **Provenance sidecars are write-once.** `storeTranscript` never overwrites
  an existing `provenance.json`/`transcript.txt` pair; `contentHash` is
  therefore permanent for a given episode UUID once first stored.
- **Evolution is additive-only within a major version.** New fields may be
  added to `provenance.json` or `state.json` without bumping `schemaVersion`;
  readers must tolerate missing fields (sidecars written before a field
  existed simply omit it). A breaking change (removing or repurposing a
  field) requires a `schemaVersion` bump.

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
| STT cost surprises | Free local Whisper is preferred whenever a CLI is detected; cloud STT is off by default and requires explicit `CASTRECALL_ENABLE_STT=true` plus a provider key; every skip says why. |
| Local Whisper subprocess safety | Only auto-runs binaries found on PATH by known name with fixed arguments; `CASTRECALL_WHISPER_COMMAND` is user-supplied and runs with the user's own privileges (same trust model as their shell); audio paths are shell-quoted; temp dirs cleaned up. |
| Path traversal via hostile UUIDs | `safeName()` sanitizes all path components (tested). |
| Scheduler hammers a down/broken Pocket Casts API | `castrecall_run_pipeline`'s cooldown gate: capped exponential backoff after login/history failures, cleared on the next success; a run inside the window makes zero Pocket Casts calls. Documented in README; never bypass via `force: true` in a recipe. |
| Overlapping scheduled runs | `.staging/pipeline.lock` (exclusive-create, TTL-based stale reclaim, token-checked release) ensures at most one run reaches the Pocket Casts API at a time; the underlying storage writes (`recordListens`, `storeTranscript`, `writeReviewCandidate`) are independently idempotent, so even a bypassed lock cannot corrupt state. |

## Rung 3: local Whisper design notes

Nothing is bundled — the rung auto-detects a Whisper CLI the user already has
(`whisper-cli`/`whisper-cpp`, `mlx_whisper`, `whisper-ctranslate2`, `whisper`)
and is skipped with install hints when absent. This keeps the plugin install
weightless for strangers while making the free, private option the default
generated-transcription path for anyone who has one installed. whisper.cpp
needs a ggml model (`CASTRECALL_WHISPER_MODEL`) and ffmpeg for non-WAV audio;
the Python CLIs decode audio themselves. `CASTRECALL_WHISPER_COMMAND` accepts
any custom command with an `{input}` placeholder (stdout = transcript).

## Future rungs / ideas (not in v0)

- Podcast Index API as an additional feed/transcript resolver.
- More platforms (Spotify, Apple Podcasts) behind the same `ListenRecord` model.
- An approval tool that moves a reviewed candidate into a user-designated notes
  directory (still never directly into OpenClaw memory).
