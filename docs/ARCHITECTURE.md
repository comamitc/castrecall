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
├── index.ts               # OpenClaw plugin entry: defineToolPlugin + 8 tools
├── tools.ts               # Tool implementations, pure over (config, params, deps)
├── pipeline.ts            # castrecall_run_pipeline: sync → transcript → review, locked + cooldown-gated
├── config.ts              # Env-first config resolution; secrets never in plugin config
├── storage.ts             # Data dir layout, state.json, idempotent writes, pipeline lock + sync backoff
├── review.ts              # Review-candidate markdown generation (heuristic excerpts)
├── corpus-export.ts       # Opt-in export: section-split, frontmattered markdown pages (gbrain, etc.)
├── search.ts              # castrecall_search: on-disk term-freq index + keyword/phrase ranking
├── resolver.ts            # Pocket Casts listen → RSS feed URL → feed item + transcript links
├── retry.ts               # Per-request retry: capped exponential backoff for transient fetch failures
├── pocketcasts/
│   ├── client.ts          # Read-only unofficial API adapter (login + history)
│   ├── secret-store.ts    # OS keychain backend (macOS `security` / libsecret `secret-tool`)
│   └── session.ts         # Auth seam: credential resolution + token cache/refresh (see below)
└── transcripts/
    ├── ladder.ts          # Orchestrates the five rungs, collects outcomes
    ├── rss.ts             # Rung 1: <podcast:transcript> fetch, format preference
    ├── taddy.ts           # Rung 2: Taddy GraphQL (optional)
    ├── podchaser.ts       # Rung 3: Podchaser GraphQL, two-hop transcript-URL fetch (optional)
    ├── local-whisper.ts   # Rung 4: detected local Whisper CLI (free, private)
    ├── stt.ts             # Rung 5: AssemblyAI / OpenAI / Deepgram (optional, gated, paid)
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
Transcript ladder: RSS <podcast:transcript> → Taddy → Podchaser → local Whisper (detected) → cloud STT (explicitly enabled)
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

This cooldown is one of three independent backoff layers, deliberately at
different scales. `retry.ts`'s `fetchWithRetry` retries a *single* request
(login, history, feed-export, RSS/Taddy transcript fetch) in-process on a
network error or a 429/5xx, at request scale (`RETRY_BASE_MS`/`RETRY_CAP_MS`,
~250ms–2s, ~750ms worst case for the default 3 attempts) — it never retries
401/403, which every caller's existing auth-error branch still handles on
the first response. If a sync still fails after those in-request retries
exhaust, the cooldown above backs off the *next scheduled run* at the much
larger `BACKOFF_BASE_MS`/`BACKOFF_CAP_MS` (minutes–hours) scale. The two are
intentionally not shared: reusing the cooldown's minute-scale constants
per-request would stall an in-progress sync for minutes on a single
transient blip. The third layer, per-episode transcript backoff
(`transcriptRetry`/`transcriptRecheck`, see below), is scoped to one episode
rather than the whole sync and is likewise kept separate — see "Event-driven
transcript availability" below for why.

### Event-driven transcript availability (webhook substitute)

Issue #9 asked for Taddy webhook subscriptions so a transcript published
after an episode's first ladder run triggers ingestion automatically.
CastRecall is an OpenClaw tool plugin with no HTTP server and no reachable
inbound endpoint, so a literal webhook can't ship in this architecture — the
shipped substitute is scheduled polling, reusing the same "stay `none`, carry
a `nextEligibleAt`, let the pipeline re-check and defer" pattern
`transcriptRetry` already established for transient STT failures.

`ladder.ts` marks a rung `recheckable: true` when the miss means "not
available *yet*", not "will never be available": Taddy reporting
`taddyTranscribeStatus` as `PROCESSING`/`TRANSCRIBING` (`taddy.ts`'s
`isTranscribingStatus`, an explicit allowlist — `NOT_TRANSCRIBING` contains
the substring `TRANSCRIBING` but is the terminal state, so a substring
fallback must negate it), and an RSS feed item that currently declares no
`<podcast:transcript>` links. `tools.ts`'s `fetchTranscript` then keeps the
episode `transcriptStatus: "none"` and advances a `transcriptRecheck` capped
backoff (`TRANSCRIPT_RECHECK_BASE_MS`/`_CAP_MS`, hours-to-a-day scale) instead
of marking it terminally `failed`; `pipeline.ts`'s eligibility gate defers
until the *later* of `transcriptRetry.nextEligibleAt` and
`transcriptRecheck.nextEligibleAt`. Once `firstDeferredAt` exceeds
`TRANSCRIPT_RECHECK_MAX_AGE_MS` (14 days), the episode converges to
terminally `failed` so a scheduler never polls forever.

`transcriptRecheck` is a **sibling** to `transcriptRetry`, not a reuse of it:
`transcriptRetry`'s attempt cap exists specifically to bound paid-STT
re-billing (see the comment on `TRANSCRIPT_RETRY_MAX_ATTEMPTS` in
`storage.ts`), while `transcriptRecheck`'s horizon is a futile-poll bound —
overloading one field for both would blur that billing invariant. Where both
apply to the same episode (e.g. a transient Deepgram failure on an episode
Taddy is also still transcribing), `fetchTranscript` checks `retryable`
*before* `recheckable`, so the STT-billing path always wins and
`transcriptRecheck` is never set in that case.

If OpenClaw later exposes inbound HTTP for plugins, a real Taddy webhook
handler would land at exactly this point: it would flip an episode's
`transcriptRecheck`-gated eligibility immediately rather than waiting for the
next scheduled poll, with no other change to the ladder or pipeline.

Only episodes newly recorded this run get `fetchTranscript`, and only
episodes newly stored this run get `generateReview` — a pre-existing
stored-without-review episode is left for an explicit
`castrecall_generate_review` call, not swept in by the scheduler.

### Credential handling: the `session.ts` auth seam

`pocketcasts/session.ts` is the only module that resolves credentials, obtains
a session token, or re-authenticates — nothing outside it calls
`login()`/`fetchHistory()` directly, keeping the "auth confined to one module"
invariant from v0's design intact as this feature adds a second credential
input mechanism.

- **Credential precedence:** OS keychain (`resolvePocketCastsCredentials`)
  wins over `POCKETCASTS_EMAIL`/`POCKETCASTS_PASSWORD` when a backend is
  detected (`secret-store.ts`'s `detectSecretBackend`, following the same
  "detect a CLI, drive it through an injected `ExecImpl`" pattern as
  `transcripts/local-whisper.ts`) and both `pocketcasts-email` /
  `pocketcasts-password` entries exist under the resolved service (default
  `castrecall`, or `CASTRECALL_SECRET_SERVICE`). A keychain read failure
  degrades to the env fallback — it never throws.
- **Token precedence:** an in-memory, process-lifetime cache → a durable
  keychain token record (account `pocketcasts-token`, JSON-encoded
  `{ token, expiresAt, credentialHash }`) → a fresh `login()`. The keychain is
  the *only* durable sink; with no backend, or with
  `CASTRECALL_DISABLE_KEYCHAIN=1`, the token still lives in the in-memory
  cache for the process's lifetime but is never written to disk — this never
  regresses the pre-existing privacy posture, it only adds reuse.
- **Expiry:** `client.ts`'s `parseTokenExpiry` decodes a JWT's `exp` claim when
  present; a non-JWT or `exp`-less token falls back to `DEFAULT_TOKEN_TTL_MS`
  (12h). A token within `TOKEN_EXPIRY_SKEW_MS` (60s) of its expiry is treated
  as already expired, so a sync never races a token that expires mid-request.
  A `401`/`403` from the history endpoint is always authoritative regardless
  of the computed expiry: `fetchHistoryWithSession` invalidates the cached
  token (best-effort keychain delete, always-effective in-memory clear) and
  retries with exactly one fresh login; a second consecutive auth failure
  propagates unchanged so `pipeline.ts`'s cooldown gate still engages.
- **Single-flight:** concurrent callers share one in-flight login promise, so
  two overlapping tool calls (or pipeline runs) with the same credentials
  never issue two logins.
- **`credentialHash`** (`sha256(email + "\n" + password)`) is stored alongside
  the cached/keychain token and checked on every read — a password rotation
  (in the keychain or env) invalidates any stale token automatically, in
  memory and in the keychain record, without an explicit migration step.
- **Failure isolation:** every keychain read degrades to "absent" (never
  throws); a write failure after a successful login is swallowed (the token
  still works from memory, so the sync itself succeeds); a delete failure
  during 401 invalidation is swallowed (the in-memory clear is the
  correctness-bearing step — a stale keychain entry is harmless because the
  forced retry login never consults the cache).
- **Subprocess safety:** `secret-store.ts` always invokes `security`/
  `secret-tool` as an argv array (never `sh -c`), so no secret value ever
  touches a shell line; the libsecret write additionally passes its value via
  stdin rather than argv. The one accepted exception is the macOS write path
  (`security add-generic-password -w <value>`), which briefly exposes the
  value in the process argument list — acceptable for the short-lived session
  token this code path writes; CastRecall itself never writes the account
  email/password to the keychain (the user does that, following the recipe
  `castrecall_setup`/README show).

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

### Search over the corpus

`castrecall_search` (`search.ts`) is a read-only keyword/phrase search over
stored transcripts, backed by a private, rebuildable index under
`.index/search-index.v1.json` (the schema version is part of the filename,
so a build only ever reads its own format and upgrade/rollback across
schema changes just rebuilds). Ranking is settled entirely from the index:
Phase 1 scores every document (tf-length-normalized + idf-lite over term
frequencies) and resolves quoted-phrase bonuses from positional postings —
sorted token positions keyed by a one-way hash of each term — by walking
the rarest phrase term's positions with binary searches. Exact matches can
therefore never be hidden behind higher-scoring near-misses, and no query
shape triggers a corpus-wide transcript scan; Phase 2 reads only the final
top-`limit` documents to build snippets. The index stores plaintext
vocabulary (term frequencies, inherent to keyword scoring) but **never the
word sequence** — positions are keyed by one-way term hashes. It is
reconciled by `contentHash` on every search: an unchanged corpus
re-tokenizes nothing, a changed transcript re-tokenizes just that document,
and a corrupt, missing, wrong-version, or structurally invalid index
self-heals via rescan (same tolerant idiom as `Storage.loadState`, same
tmp+rename write idiom as `Storage.saveState`).

Every hit carries both a `snippet` (display-formatted, `**term**`-highlighted,
`…`-elided) and a `snippetText` (the raw, verbatim transcript slice it was
built from), so quoted material always stays attributable to the transcript
and its provenance — never to a mutated string. A document with a final score
of zero (no keyword term present and no phrase match) is excluded from
results, not merely ranked low. Like corpus export, the tool assembles an
explicit `CorpusEntry[]` from `state.json` + `sources/<uuid>/` and passes it
in; `SearchIndex` never performs its own storage or provenance lookups.

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
.index/            # reserved: rebuildable castrecall_search term-freq cache — consumers must ignore it
```

`.staging/` is CastRecall's private scratch namespace: transcript artifacts are
assembled there and published into `sources/` with a single atomic rename, so
directories CastRecall publishes appear all-at-once, never half-written. The
periodic-sync run lock (`pipeline.lock`) also lives here, exclusive-created
for the same reason. `.index/search-index.v1.json` is `castrecall_search`'s
private, derived cache (term frequencies + hash-keyed positional postings,
never the plaintext word sequence) — safe to delete at any time; the next
search rebuilds it from `sources/`. Downstream scans must skip both
dot-prefixed namespaces (and any future one).

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
| `transcriptSource` | `"rss" \| "taddy" \| "podchaser" \| "local-whisper" \| "stt"`. |
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
| Credential exposure | Keychain-preferred (OS keychain via argv-only subprocess calls, stdin for libsecret writes), env-var fallback; never logged or included in errors; `setup_status` reports booleans/enums only (`credentialSource`, `secretBackend`, `tokenCache`), never values. See "Credential handling" above. |
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
- Platform-caption sources (Apple / Pocket Casts generated transcripts) were
  investigated for issue #13 and closed as **no-go**: both are real sources
  distinct from RSS rung 1. Apple requires reverse-engineered cryptographic
  request signing with no documented API. Pocket Casts' generated
  transcripts are reachable through a stable, unauthenticated, community
  reverse-engineered endpoint (`podcast-api.pocketcasts.com/show_notes/full`)
  — but that same lack of auth means the endpoint serves a Plus/Patron-gated
  feature to anonymous callers, so using it would mean bypassing Pocket
  Casts' subscription paywall rather than merely depending on an unofficial
  API. See `docs/transcript-source-investigation.md`. Revisit if either
  platform publishes a documented transcript API, or if Pocket Casts adds an
  auth/entitlement check to `show_notes/full`.
