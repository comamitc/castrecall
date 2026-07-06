# Changelog

## v0.4.0 — 2026-07-06

Ladder breadth: a second cloud STT provider, and an honest answer on
platform captions.

- **Deepgram STT provider** (#12, PR #31): `CASTRECALL_STT_PROVIDER=deepgram`
  (+ `DEEPGRAM_API_KEY`, model via `CASTRECALL_DEEPGRAM_STT_MODEL`, default
  nova-3) joins AssemblyAI and OpenAI on the paid rung 4. Deepgram's
  prerecorded endpoint takes the audio URL directly and answers
  synchronously with diarized `Speaker N:` utterances — no polling, no
  download. Transient provider failures (429/5xx/timeouts and network-level
  rejections) no longer strand an episode as terminally failed OR retry
  forever: each episode gets capped exponential backoff (5→60 min) with a
  5-attempt budget surfaced in `castrecall_setup_status`, and scheduled runs
  defer not-yet-eligible episodes instead of re-billing the provider every
  tick.
- **Platform-caption sources investigated, declined** (#13, PR #30):
  `docs/transcript-source-investigation.md` documents why Apple Podcasts and
  Pocket Casts generated transcripts are NOT being added as ladder rungs —
  Pocket Casts' endpoint is unauthenticated and using it would bypass their
  Plus/Patron paywall; Apple's requires reverse-engineered request signing.
  The runtime ladder stays at 4 rungs.

## v0.3.0 — 2026-07-05

Robustness: credentials move off plaintext env vars, every Pocket Casts call
survives transient failures, and history sync stops recording episodes you
never actually listened to.

- **OS-keychain credential handling** (#7, PR #26): Pocket Casts credentials
  and session-token records can live in the OS keychain (macOS `security`,
  Linux libsecret) instead of plaintext env vars, with env vars still
  supported as a fallback. Session tokens are cached in memory and persisted
  with concurrency-safe single-flight login and per-service serialization of
  durable writes — no duplicate logins, no torn token records.
- **Retry/backoff for the unofficial API** (#6, PR #27): new shared
  `fetchWithRetry` primitive retries network errors, 5xx, and 429 with
  capped exponential backoff (3 attempts, request-scale delays), applied to
  Pocket Casts login and history calls — deliberately independent of the
  cross-run sync cooldown, which keeps governing run-scale pacing.
- **Listened-episode filter** (#24, PR #28): history sync now records only
  episodes that were meaningfully listened to — completed (playingStatus 3),
  ≥80% played by duration, or ≥5 minutes when Pocket Casts reports no usable
  duration — instead of everything ever touched. Thresholds configurable via
  `CASTRECALL_MIN_LISTEN_RATIO`, `CASTRECALL_MIN_LISTEN_SECONDS`, and
  `CASTRECALL_RECORD_UNKNOWN_LISTENS`; already-stored episodes are never
  re-filtered.

## v0.2.0 — 2026-07-05

Freshness & onboarding: the corpus now feeds itself on a schedule, and setup
is a guided conversation instead of a README treasure hunt.

- **Scheduled/background pipeline** (#3, PR #22): new `castrecall_run_pipeline`
  tool chains sync → transcripts → corpus export → review candidates with no
  human input. Fail-closed run lock (exclusive-create, heartbeat renewal, zero
  automatic reclaim; explicit `breakStaleLock` recovery serialized behind an
  unstealable mutex), capped-backoff cooldown so the unofficial Pocket Casts
  API is never hammered, self-healing hash-idempotent export pass, durable
  worklists that resume crashed runs, and structured `pipelineErrors` + lock
  health in `castrecall_setup_status`. README ships cron recipes.
- **Guided first-run setup** (#2, PR #23): new `castrecall_setup` tool walks
  through Pocket Casts credentials (with the Google/Apple-SSO caveat), storage
  location, privacy defaults, transcript providers, and corpus export — with
  read-only credential verification that never echoes secrets, and gbrain
  detection offering `~/.gbrain/inbox/` as the export target. Local-Whisper
  readiness (binary AND model) now has a single source of truth across setup
  and status surfaces.

## v0.1.0 — 2026-07-05

The corpus-feed milestone: CastRecall's data dir is now a versioned public
contract, and transcripts can flow into markdown brains (gbrain, Obsidian,
custom corpora) via the new corpus-export mode.

- **Data-dir contract hardening** (#15, PR #18): `contentHash` (sha256 of the
  normalized transcript) and `schemaVersion` in `provenance.json`/`state.json`;
  stable-identifier guarantees enforced at the storage boundary; atomic writes
  staged under the reserved `.staging/` namespace; `transcript.txt` documented
  as the completeness marker; CI now fails when committed `dist/` drifts from
  the built output.
- **Corpus-export mode** (#14, PR #19): opt-in via `CASTRECALL_EXPORT_DIR` or
  the `exportDir` plugin setting — storing a transcript also writes
  section-split, frontmattered markdown pages under
  `<export-dir>/podcasts/<show-slug>/<episode-slug>/`, idempotent by content
  hash. Review candidates and state are never exported.
- **Ecosystem positioning docs** (#16, PR #20): README now documents CastRecall
  as a raw-source pipeline for markdown brains, including both gbrain
  placements (inbox pickup vs sources-tree/domain-bank buckets).
