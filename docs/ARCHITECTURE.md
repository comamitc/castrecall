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
├── index.ts               # OpenClaw plugin entry: defineToolPlugin + 11 tools
├── tools.ts               # Tool implementations, pure over (config, params, deps)
├── pipeline.ts            # castrecall_run_pipeline: sync → preflight-gated transcript → review, locked + cooldown-gated
├── config.ts              # Env-first config resolution; secrets never in plugin config
├── storage.ts             # Data dir layout, state.json, idempotent writes, pipeline lock + sync backoff
├── review.ts              # Review-candidate markdown (heuristic excerpts) + promoted-note builder
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
    ├── preflight.ts       # castrecall_transcription_preflight: corpus-scale quality gate (issue #55)
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
sources/<uuid>/{raw.<ext>, transcript.txt, provenance.json, segments.json?}   ← private source lane
        │  castrecall_generate_review
        ▼
review/pending/<uuid>.md   ← approval gate; conversation is the UI (see below)
        │  castrecall_resolve_review { disposition, content? }
        ▼
review/resolved/<uuid>.md  +  <notes-dir>/*.md (promote only)
```

### Resolving reviews: `castrecall_resolve_review`

There is no approve/reject UI in an OpenClaw tool plugin — the conversation
*is* the UI. An agent surfaces a `review/pending/` candidate in chat; the
human replies in natural language with what to keep, rephrase, or discard;
the agent then calls `castrecall_resolve_review` with an explicit
`disposition` and, for `promote`, the exact `content` the human chose.

The gate is **contractual, not technical** — the same trust model as every
other agent tool (compare `castrecall_run_pipeline`'s `breakStaleLock`, which
also relies on an instructive description rather than an enforceable check).
CastRecall cannot verify a human actually approved in conversation; a
misbehaving agent could call the tool on its own initiative. The mitigations
are the explicit-parameters contract (an agent must supply the human-chosen
`content` verbatim, not just a boolean) and the tool description's
instruction to call it only after explicit confirmation.
`castrecall_generate_review` itself is untouched and remains structurally
unable to promote anything — it only ever writes to `review/pending/`.

`promote` is intentionally **non-atomic**, in this exact order: write the
note under `notesDir` → move the candidate `pending` → `resolved` → update
`state.json`. A crash between the write and the move leaves a promoted note
plus a still-pending candidate; a retry then hits the write-once collision on
the note path and throws, rather than silently double-promoting or losing
track of the candidate — the same reconciliation stance
`generateReview`/`writeReviewCandidate` take on their own write/state-update
pair. `discard` has no note to write, so it is a single move + state update.

If `CASTRECALL_EXPORT_DIR` is set, `castrecall_fetch_transcript` also projects
the same source lane out to markdown pages, independently of the review gate:

```
sources/<uuid>/{transcript.txt, provenance.json, segments.json?}
        │  castrecall_fetch_transcript (CASTRECALL_EXPORT_DIR set)
        ▼
<export-dir>/podcasts/<show-slug>/<episode-slug>/*.md   ← markdown pages (gbrain, etc. — see README)
```

### Periodic sync: `castrecall_run_pipeline`

`pipeline.ts` composes the same three tools above (`syncHistory` →
`fetchTranscript` → `generateReview`) into one chained call so a host
scheduler (OpenClaw cron/heartbeat, or OS cron — see README "Scheduled /
periodic sync") can drive the whole loop with no human input. Three properties
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
- **Corpus-scale transcription preflight (issue #55).** Before the per-episode
  transcript loop, the run calls `detectLocalWhisper` once and
  `buildTranscriptionPreflight` (`transcripts/preflight.ts`) to compute the
  same report `castrecall_transcription_preflight` returns, from
  `pendingTranscripts.length` (via the shared `selectPendingTranscripts`
  helper in `storage.ts`, so this can never disagree with the actual
  worklist). When the run is corpus-scale (`episodesPendingTranscript >=
  CORPUS_SCALE_MIN_EPISODES`), the local-Whisper rung is otherwise ready to
  run, its resolved model classifies as `"low-quality"`, and
  `CASTRECALL_WHISPER_ALLOW_LOW_QUALITY` isn't set, `preflight.blocked` is
  `true` and `skipLocalWhisper: true` is threaded into every
  `fetchTranscript` call this run — skipping only rung 4 (`ladder.ts`'s
  `skipLocalWhisper` option, mirroring the existing `skipStt` pattern); the
  free RSS/Taddy/Podchaser rungs are unaffected. A config the ladder already
  skips for another reason (missing ggml model, mlx with no model and no
  opt-in) is reported via `ready: false`, never double-blocked. The result's
  `preflight` field carries the full report. `castrecall_fetch_transcript`'s
  tool schema exposes only `episodeUuid` — it never sets
  `skipLocalWhisper` — so a single-episode call is never gated.

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

`corpus-export.ts` reads only `sources/<uuid>/{transcript.txt, provenance.json,
segments.json?}` and writes section-split, frontmattered markdown pages to a
separate, user-designated directory (`CASTRECALL_EXPORT_DIR`/`exportDir`, off
by default). It deliberately does **not** relocate the data dir into a corpus:
the raw `sources/` layout doesn't match a page-per-section shape, so export is
a bridge, not a redesign. Like review candidates, it structurally cannot read
`review/pending/` or `state.json` — it only ever reads the source artifacts a
transcript store already produces. Idempotency is keyed off `contentHash` (see
below); a changed hash replaces the whole episode's page set atomically so no
stale section files survive a shorter re-transcription.

**Timestamped sections (issue #43).** When `segments.json` exists (VTT/SRT/JSON
sources carry segment start/end timing; plain text and other sources don't),
`buildCorpusPages` maps each section's approximate position onto the segment
timeline and adds quoted `approx_start`/`approx_end` (`HH:MM:SS`) to that
section's frontmatter, plus a ` — HH:MM:SS` suffix on its link in `index.md`.
The mapping is proportional and therefore approximate — `transcript.txt` is
deduped/whitespace-collapsed (see `segmentsToText` in `normalize.ts`), so char
offsets don't line up exactly with segment boundaries — but it is always
non-decreasing across ordered sections and never renders `NaN`; a section that
maps into a gap left by an untimed segment simply omits both fields. The
episode-level span (first section's `approxStart` through the last section's
`approxEnd`) is written to `index.md`'s frontmatter too, which doubles as the
**sole reconciliation marker**: `readExistingExportMeta` reads only
`index.md`, so an episode exported before segments existed re-exports once
(same idempotent backfill idiom as `quality`, issue #41) as soon as segments
with numeric times become available, then settles.

**Speaker turns (issue #44).** Provider speaker labels — from VTT/SRT/JSON
(`normalize.ts`) and from AssemblyAI/Deepgram diarization (`stt.ts`, both
routed through the same `segmentsToText` formatter so speaker-turn text never
diverges by source) — normalize into one internal `TranscriptSegment.speaker`
field. `buildCorpusPages` derives `distinctSpeakers(segments)` and, only when
non-empty, adds a `speakers: [...]` line to both the section and index
frontmatter — provider-given labels only, never invented, so a speaker-less
source (local Whisper, plain text) emits no line at all. `speakers:` on
`index.md` reconciles the same both-or-neither way as timestamps: an episode
exported before segments carried speakers re-exports once to backfill it, then
settles.

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
  segments.json      # optional — only written when the source carried segment timing (issue #43)
review/pending/<episodeUuid>.md
review/resolved/<episodeUuid>.md   # moved here by castrecall_resolve_review; disposition lives in state.json
.staging/          # reserved: in-flight atomic writes + pipeline.lock — consumers must ignore it
.index/            # reserved: rebuildable castrecall_search term-freq cache — consumers must ignore it
```

Promoted note *content* is written to the separately configured
`CASTRECALL_NOTES_DIR`/`notesDir` — outside this data dir entirely, and never
into durable OpenClaw memory.

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
| `generation` | Exact generation provenance, discriminated by `kind`: local-transcription details (issue #54) when `transcriptSource` is `"local-whisper"`, or remote-stt details (issue #61) when `transcriptSource` is `"stt"` and the configured provider was `remote-stt`. See below. |
| `quality` | Deterministic transcript quality score (issue #41): `score` (0-100), `tier` (`quote-safe`/`reviewable`/`search-only`), and machine-readable `reasons`. See below. |
| `cleanup` | Deterministic cleanup-pass provenance (issue #45): `version` and the named transform steps that actually changed the text (`applied: []` when the input was already clean). Present whenever the cleanup pass ran, even as a no-op; omitted entirely when `CASTRECALL_TRANSCRIPT_CLEANUP=false` disabled it, so "ran, no-op" is distinguishable from "never ran". See below. |
| `format` | Raw transcript format (`vtt`, `srt`, `json`, `txt`, ...). |
| `fetchedAt` | ISO timestamp of the fetch that produced this sidecar. |
| `privacyClass` | Always `"private-source"`. |
| `contentHash` | sha256 (hex) of the exact bytes written to `transcript.txt` — the normalized, cleaned transcript text (see "Transcript cleanup pass", issue #45). Computed once, at first write, so it is stable across re-runs; downstream consumers can key idempotency off it. |
| `schemaVersion` | Data-dir contract version (currently `1`). |

### `segments.json` (issue #43)

An optional sidecar: the exact `TranscriptSegment[]` the ladder produced
(`normalize.ts`), written atomically alongside `transcript.txt`/
`provenance.json` only when non-empty. VTT/SRT/JSON sources populate it, as
does diarized cloud STT (AssemblyAI/Deepgram, issue #44 — `speaker` plus
timing when the provider returns utterance start/end); plain text, HTML,
Taddy/Podchaser body text, local Whisper, and OpenAI's flat-text STT response
have no per-segment data, so no file is written and `readSegments` returns
`undefined` — the same additive, tolerant-absence idiom as
`provenance.generation`/`quality`. Each entry: `text` (required), plus
optional `speaker` (provider-given label, normalized to `Speaker <id>` for
numeric provider ids), `start`/`end` (raw source-format strings) and
`startSeconds`/`endSeconds` (parsed seconds — see `timecodeToSeconds` — used
by corpus export's `approx_start`/`approx_end`).

#### `provenance.generation` fields (local Whisper only, issue #54)

`local-whisper:mlx-whisper` alone hides the difference between `whisper-tiny`
and `large-v3-turbo`; `generation` records the exact backend, model, and
decode settings a transcript was actually produced with, assembled in
`local-whisper.ts`'s `buildGeneration` from the same
`resolveWhisperModel`/`resolveWhisperDecodeArgs` results the run's argv was
built from, so it can never disagree with what actually executed.

| Field | Notes |
| --- | --- |
| `backend` | The detected Whisper flavor (`mlx-whisper`, `whisper.cpp`, `openai-whisper`, `whisper-ctranslate2`, or `custom`). |
| `model` | Concrete model id/path; `undefined` when the backend ran its own default or the flavor is `custom`. |
| `modelSource` | `"explicit"` (`CASTRECALL_WHISPER_MODEL`), `"preset"` (`CASTRECALL_LOCAL_WHISPER_PRESET`), `"backend-default"` (no model pinned, backend ran its own default — the auditable "this corpus may have been generated with a poor default model" marker), or `"none"` (custom flavor with no model). |
| `usesBackendDefault` | `true` only for `modelSource: "backend-default"`. CastRecall never fabricates a concrete default model string here — it genuinely never observes one, since no `--model` flag is passed. |
| `preset` | The preset name, if one resolved a model. |
| `outputFormat` | Stored artifact shape: `txt \| json \| vtt \| srt`. |
| `wordTimestamps` | Whether word-level timing actually survived into the stored artifact — not merely whether it was requested (only `true` for a `json` artifact). |
| `decode.applied` | Effective option → concrete value, for decode options this run actually applied. |
| `decode.ignored` | Decode options this run bypassed, with reasons — verbatim from `resolveWhisperDecodeArgs`, so nothing is silently dropped. |
| `toolVersion` | Best-effort `<tool> --version` output; `undefined` when unavailable, on a non-zero exit, or for the `custom` flavor. Never blocks or fails a transcription. |

#### `provenance.generation` fields (remote-stt only, issue #61)

`generation.kind === "remote-stt"` records what the configured self-hosted
service (WhisperX, faster-whisper, or anything else implementing the
contract — see README "Remote STT contract") reported about itself, plus how
the job actually ran. `baseUrlHost` is deliberately host-only — never the
full base URL (which may carry a path/query) or the bearer token — assembled
in `transcripts/remote-stt.ts`'s `transcribeWithRemoteStt`.

| Field | Notes |
| --- | --- |
| `implementation` | Implementation name self-reported by the remote service (e.g. `"whisperx"`), if it returned one. |
| `model` | Model name/id self-reported by the remote service, falling back to `CASTRECALL_REMOTE_STT_MODEL` when the response didn't include one. |
| `baseUrlHost` | `new URL(base).host` — host only, never the token or the full base URL/path. |
| `mode` | `"sync"` (the submit response was the normalized result directly) or `"async"` (a `job_id` was polled to completion). |
| `submittedBy` | `"audio_url"` (default) or `"upload"` (`CASTRECALL_REMOTE_STT_UPLOAD=true` — audio downloaded and multipart-uploaded instead). |
| `warnings` | Provider-reported warnings, if any. |
| `durationSeconds` | Provider-reported audio duration, if reported. |

`worker/whisperx/` (issue #62) is an optional, self-contained reference implementation of this contract for CUDA hosts — not required by anything above; see its own README.

#### `provenance.quality` fields (issue #41)

A stored transcript's `quality` is computed once, at store time, by
`scoreTranscriptQuality` (`transcripts/quality.ts`) — a pure, deterministic
classifier with no I/O. It considers empty/short output, repetition loops
(composing the same `detectRepetitionLoop` used for #42 quarantine, so the two
signals never disagree), lexical variety, suspicious segment lengths, the
source rung as a source-class proxy (no independent provider-confidence
metadata exists, so `local-whisper`/`stt` are treated as lower-confidence than
a published RSS/Taddy/Podchaser transcript), and whether segment-level
timestamps/speaker labels are present.

| Field | Notes |
| --- | --- |
| `score` | Integer 0-100, clamped. Starts at 100 and loses points per triggered reason. |
| `tier` | `"quote-safe"` (score ≥ 90, no repetition loop), `"reviewable"` (score ≥ 60), or `"search-only"` (below that, or a repetition loop was detected — a loop always forces `search-only` regardless of score). |
| `reasons` | Machine-readable codes for every rule that fired: `empty`, `too-short`, `repetition-loop`, `low-lexical-variety`, `suspicious-segment-lengths`, `low-source-confidence`, `no-timestamps`, `no-speaker-labels`. Empty array when nothing fired. |

Additive to `Provenance`; pre-#41 sidecars simply lack `quality`. Corpus
export renders it as `transcript_quality_score`/`transcript_quality_tier`/
`transcript_quality_reasons` frontmatter (see "Corpus export" in the README),
omitted entirely when absent.

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

`reviewDisposition` (`"promote" | "discard"`), `reviewResolvedAt`, and
`promotedNotePath` (promote only) are written once per episode by
`castrecall_resolve_review` and never cleared — they are disposition
*history*, not a live pointer, so `castrecall_setup_status`'s
`counts.reviewsResolved` (a count of episodes with `reviewDisposition` set)
stays accurate even after the underlying `review/resolved/<uuid>.md` file is
deleted by the user.

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
3. Listen Notes podcast search (optional, needs `LISTENNOTES_API_KEY`), matched
   by podcast title — a last-resort discovery fallback, not a transcript-ladder
   rung; Listen Notes' own docs say under 1% of episodes have transcripts.

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
| Silent corpus-scale low-quality transcription (issue #55) | `castrecall_run_pipeline` computes a preflight from the same detection/resolvers the ladder uses and blocks the local-Whisper rung for a corpus-scale run (5+ episodes pending, model resolves low-quality, no opt-in) — reported via the run's `preflight` field and `castrecall_transcription_preflight`. Single-episode `castrecall_fetch_transcript` is never gated. See "Periodic sync" above. |
| Whisper repetition loops poisoning the corpus (issue #42) | `transcripts/loop-detection.ts` flags repeated phrase/word loops in ladder output before it is ever stored; a hit sets `transcriptStatus: "quarantined"` and writes no transcript artifact, so search/export/review (all filter on `"stored"`) and scheduled auto-retry (`selectPendingTranscripts` only re-queues `"none"`) both exclude it automatically. See "Repetition-loop quarantine" below. |

## Rung 3: local Whisper design notes

Nothing is bundled — the rung auto-detects a Whisper CLI the user already has
(`whisper-cli`/`whisper-cpp`, `mlx_whisper`, `whisper-ctranslate2`, `whisper`)
and is skipped with install hints when absent. This keeps the plugin install
weightless for strangers while making the free, private option the default
generated-transcription path for anyone who has one installed. whisper.cpp
needs a ggml model (`CASTRECALL_WHISPER_MODEL`) and ffmpeg for non-WAV audio;
the Python CLIs decode audio themselves. `CASTRECALL_WHISPER_COMMAND` accepts
any custom command with an `{input}` placeholder (stdout = transcript).

### Corpus-scale transcription preflight (issue #55)

`transcripts/preflight.ts` is a pure builder mirroring `setup.ts`'s
`buildSetupPlan`: it receives a pre-detected `WhisperDetection` and does no
I/O itself (detection is the caller's job — `transcriptionPreflight()` in
`tools.ts` for the standalone read-only tool, `runPipeline` for the gate).
It reuses `resolveWhisperModel`, `resolveWhisperDecodeArgs`, and
`localWhisperReadiness` — the exact resolvers a real run uses — so its report
can never disagree with what the ladder would actually do.

- `classifyWhisperModelQuality` classifies the **resolved model string**, not
  the preset/flavor name: a preset always resolves to one of
  `WHISPER_PRESETS`' concrete model strings first (`best`/`balanced` →
  `...large-v3-turbo`, `fast` → `...small-mlx`), so classifying the resolved
  string keeps this in sync with `resolveWhisperModel` by construction rather
  than duplicating preset-name logic. A `large-v3` family model is
  `"approved"`; `tiny`/`base`/`small` are `"low-quality"`; an unrecognized
  explicit model, a custom command, or another backend's un-pinned default is
  `"unknown"` — deliberately never a false `"approved"`. mlx-whisper's
  un-pinned default is the one backend-default case classified `"low-quality"`
  outright, since it's documented to silently fall back to Whisper's tiny
  model (see `MLX_WHISPER_MODEL_MISSING_MESSAGE`).
- The block predicate is `corpusScale && ready && quality === "low-quality" &&
  !lowQualityOptIn`. The `ready` precondition is deliberate: `
  localWhisperReadiness` already skips a rung that can't run at usable
  quality at all (whisper.cpp with no ggml model, mlx-whisper with no model
  and no opt-in, an unresolvable preset) with its own actionable message —
  gating those too would double-handle a config the ladder was never going
  to run anyway. Those cases surface via `ready: false` /
  `readinessReason`, not `blocked`.
- `CORPUS_SCALE_MIN_EPISODES` (5) is the one exported threshold constant —
  a product judgment call, not a technical constraint, kept in one place so
  it can be revisited without touching the gating logic.
- `estimateRuntimeClass` buckets by pending-episode count into coarse classes
  (`unknown` with no backend detected, `none` with zero pending, then
  widening buckets), always paired with an explicit "rough estimate, no
  audio durations known" caveat — it never claims precision it doesn't have.

### Repetition-loop quarantine (issue #42)

Local Whisper (and, less often, other STT-based rungs like Taddy/Podchaser)
can degenerate into repeating the same phrase or single word for the rest of
a transcript. `transcripts/loop-detection.ts`'s `detectRepetitionLoop` is a
pure classifier, run in `fetchTranscript` on every ladder source's output
right before it would otherwise be stored:

- **Phrase loop:** a repeated 1..10-word n-gram flags when it repeats
  consecutively at least `MIN_REPEATS` (6) times **and** either covers at
  least `MIN_LOOP_TOKENS` (30) tokens or `COVERAGE_THRESHOLD` (35%) of the
  transcript.
- **Single-token flood:** a run of one identical word `>= WORD_RUN_THRESHOLD`
  (20) flags on its own, even when too small a fraction of a long transcript
  to satisfy the phrase rule — real speech essentially never repeats one
  word this many times in a row.
- Transcripts under `MIN_TOKENS` (60) are never flagged — too short to
  distinguish a loop from legitimate brevity.

A hit sets `transcriptStatus: "quarantined"` and `transcriptError` to the
detector's human-readable reason, and — deliberately — `storeTranscript` is
never called, so no `sources/<uuid>/` artifact exists for the episode.
Because every trusted reader (search, corpus export, review generation,
digest) filters on `transcriptStatus === "stored"`, a quarantined episode is
excluded from all of them by construction, with no extra guard needed at
those call sites. `selectPendingTranscripts` only re-queues `"none"`, so
scheduled runs never re-run the same looping model and re-loop — mirroring
the terminal-`"failed"` and STT-retry-exhausted precedents that also stop
futile re-attempts once an outcome is known. Regeneration is
operator-initiated: since no `transcript.txt` exists, `hasTranscript` stays
false, so changing `CASTRECALL_LOCAL_WHISPER_PRESET` or the STT provider and
calling `castrecall_fetch_transcript` again re-runs the full ladder; clean
output then stores normally and clears `transcriptError`.

### Transcript cleanup pass (issue #45)

Raw transcripts are readable but rough: STT output glues punctuation to the
next word, and caption sources leave behind non-speech cue markers and
caption-carets. `transcripts/cleanup.ts`'s `cleanTranscript` is a pure
transform — no I/O, mirrors `loop-detection.ts`/`quality.ts`'s
options-with-defaults/exported-result-type shape — run in `fetchTranscript`
right after loop detection and quality scoring (both of which stay on
`result.transcript.text`, the raw-normalized text, so their coverage/quality
math never sees cleaned-up text) and just before `storeTranscript`.

Five named, ordered steps, each only appended to the result's `applied` list
when it actually changes the text: `strip-standalone-cues` (removes a line
that consists solely of an allowlisted non-speech cue like `[MUSIC]` or
`(inaudible)` — a cue embedded mid-sentence is left alone), `strip-caption-markers`
(leading `>>`/`>>>` carets and dialogue dashes at line start),
`fix-punctuation-glue` (de-glues/de-duplicates *existing* punctuation only —
`word.Next` → `word. Next`, `word ,next` → `word, next`, `?.` → `?` — never
adds punctuation where none existed), `separate-speaker-turns` (promotes a
single `\nName:` turn boundary to a blank-line paragraph break), and
`collapse-whitespace` (a final re-collapse, reusing `normalize.ts`'s
`collapseWhitespace`, since cue/marker removal can introduce new blank lines
or runs of spaces).

The hard invariant — enforced by a property test in `cleanup.test.ts` — is
that `spokenTokens(cleanTranscript(x).text)` equals `spokenTokens(x)` for any
input `x`, where `spokenTokens` tokenizes text with standalone cue lines
removed first (the same removal `cleanTranscript` itself performs). Cleanup
therefore can delete *only* allowlisted cue tokens; every other token is
preserved in order — it never paraphrases, summarizes, or invents a word.
Every step is pure regex/string manipulation (no model call), so cleanup is
deterministic and idempotent by construction.

`CASTRECALL_TRANSCRIPT_CLEANUP=false` disables the pass entirely: `transcript.txt`
is then stored exactly as `normalizeTranscript` produced it, and
`provenance.cleanup` is omitted (rather than written as a no-op), so "ran,
no-op" (`applied: []`) is distinguishable from "never ran." `raw.<ext>` is
never touched by cleanup either way, so the pre-cleanup text is always
recoverable by re-normalizing it — `deriveSegmentsFromRaw`'s exact-match guard
(issue #43) was extended to accept a match on `normalizeTranscript(raw).text`
*or* `cleanTranscript(normalizeTranscript(raw).text).text`, so segment-timing
recovery keeps working for both cleaned and pre-#45/disabled-cleanup
episodes. `segments.json` itself is unaffected by cleanup — it's written from
the ladder's raw segment objects, so corpus export's timestamped sections
still quote raw (uncleaned) segment text even when the aggregate
`transcript.txt` is cleaned; that divergence is intentional, not a bug.

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
