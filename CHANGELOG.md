# Changelog

## v0.18.0 — 2026-07-07

The remote STT track — and the roadmap — completes: endpoint validation in
setup, and the provider model documented end to end.

- **Remote-endpoint setup/status checks** (#63, PR #87): remote STT
  endpoints are now validated with the same rigor as local Whisper and
  cloud providers — reachability, auth, reported implementation/model, and
  contract-shape checks surface in `castrecall_setup` and
  `castrecall_setup_status` before a corpus run ever depends on the
  service, with clear per-failure reasons (unreachable host, rejected
  token, unsupported response shape).
- **Remote/self-hosted STT docs** (#64, PR #88): README and setup docs now
  frame the full provider model — built-in cloud providers, local Whisper,
  and self-hosted remote STT as a supported advanced tier with WhisperX as
  the reference worker — so a GPU deployment reads as a documented path,
  not bespoke infrastructure.

## v0.17.0 — 2026-07-07

Self-hosted transcription becomes a first-class provider: a generic
remote-STT contract, and a reference WhisperX worker that implements it.

- **Generic remote STT provider contract** (#61, PR #84):
  `CASTRECALL_STT_PROVIDER=remote-stt` calls any private/self-hosted STT
  service — WhisperX, faster-whisper, anything speaking the documented
  contract (bearer auth; `GET /health`; `POST /transcribe` by
  `audio_url` or multipart upload; sync inline results or async
  `job_id` + `GET /jobs/{id}` polling; normalized text/segments/model
  metadata). Hardened across eleven review rounds: setup probes the
  health endpoint; uploads spool to disk (never full-episode buffering);
  timed-out async jobs are resumed by a persisted job id keyed to the
  full request configuration — never resubmitted as duplicate GPU work —
  with unknown-job responses the only fresh-submit trigger and ambiguous
  auth failures retained under a bounded, progress-resetting counter.
- **WhisperX reference worker** (#62, PR #85): an optional, self-contained
  FastAPI worker under `worker/whisperx/` (Dockerfile + compose + smoke
  test + 55-test suite) implementing the contract on CUDA hosts —
  bounded job queue with backpressure, diarization/timestamps flags, and
  defense-in-depth on `audio_url` fetching: only globally-routable
  non-multicast destinations, DNS-rebinding-proof pinned connections
  across every validated address and redirect hop, per-attempt staging
  truncation, and upload size enforced before the body is ever parsed.

## v0.16.0 — 2026-07-06

The transcript quality track completes: readable transcripts, and known
proper nouns corrected deterministically.

- **Transcript cleanup pass** (#45, PR #81): a conservative, versioned
  cleanup improves punctuation, sentence boundaries, paragraphing,
  whitespace, and caption artifacts without ever adding, reordering, or
  inventing a word. Cleanup provenance records the version and exactly
  which steps changed the text, and segment recovery from raw artifacts is
  gated by a timing-aware hash so drifted cue timestamps (or drifted text)
  can never contaminate exported timing — legacy hash-less sidecars fall
  back to exact-text matching only.
- **Proper-noun correction glossary** (#46, PR #82): an optional
  user/project glossary (`CASTRECALL_GLOSSARY` JSON) corrects known STT
  manglings ("chat gpt" → "ChatGPT") with exact whole-token matching only —
  no fuzzy matching, global longest-first resolution, single-pass
  application with no cascades — and every applied correction recorded in
  provenance. Matching scales to large glossaries (two native scans total,
  constant-time lookup with a Unicode-fold-safe fallback), and glossaries
  whose case-insensitive variants are indistinguishable under Unicode case
  folding while mapping to different canonicals are rejected at load time
  (`matchCase: true` is the exact-matching escape hatch). Segment text is
  corrected through the same cleanup-normalized path as the transcript.

## v0.15.0 — 2026-07-06

Transcripts gain structure: timing and speakers survive from provider
output all the way into the exported corpus.

- **Timestamped transcript segments** (#43, PR #78): VTT/SRT/JSON provider
  output and STT responses now normalize into segments with start/end
  times that persist through storage and surface in corpus export, so
  downstream consumers can anchor quotes to a position in the episode
  instead of losing all timing at ingestion.
- **Speaker metadata and diarization** (#44, PR #79): speaker labels from
  provider transcripts and diarizing STT backends are normalized,
  preserved in stored metadata, and included as speaker turns in exported
  corpus pages when available — attribution-grade structure on top of
  #43's segments, with sources that carry no speaker data degrading
  cleanly.

## v0.14.0 — 2026-07-06

The transcript quality track begins: bad transcripts get caught and
quarantined, good ones get a machine-readable score.

- **Whisper repetition-loop detection and quarantine** (#42, PR #75): local
  Whisper output is checked for repeated phrase/sentence loops during
  normalization. A looping transcript is stored but quarantined —
  excluded from every trusted corpus path (search, review generation,
  digest, markdown/corpus export) instead of poisoning them — with the
  detection reason recorded and pre-existing state files loading
  unchanged.
- **Transcript quality scoring** (#41, PR #76): every stored transcript's
  provenance now carries a deterministic quality score, tier
  (quote-safe / reviewable / search-only), and reasons — considering
  emptiness/length, repetition and lexical variety, segment shape, and
  source confidence. Corpus export writes the score into page frontmatter
  and backfills pre-upgrade exports; rescoring re-exports a same-hash
  page so frontmatter never goes stale, while legacy provenance without a
  quality value can never erase an existing score.

## v0.13.0 — 2026-07-06

Local-Whisper guardrails, part three: look before you transcribe a corpus.

- **Corpus-scale transcription preflight** (#55, PR #72):
  `castrecall_run_pipeline` now summarizes the selected transcription
  backend, concrete model, and quality classification before touching a
  worklist, and blocks corpus-scale local transcription when the config is
  low-quality (fast preset, allow-low-quality opt-out, or backend default)
  unless explicitly overridden. A preflight block is a reversible policy
  gate: affected episodes return `preflight-blocked` with zero state
  writes — no retry, recheck, or failure metadata advances — so fixing the
  config makes everything immediately eligible again. Single-episode
  `castrecall_fetch_transcript` calls are never gated.
- **Local-model docs** (#56, PR #73): README and `.env.example` now make
  the quality requirements impossible to miss — MLX needs an explicit
  model or preset (never the silent upstream tiny default), whisper.cpp
  needs a ggml path, and each preset's concrete model is spelled out.

## v0.12.0 — 2026-07-06

Local-Whisper guardrails, part two: loop-safe decoding you can steer, and
provenance that names exactly what produced every local transcript.

- **Loop-safe decoding options** (#53, PR #68): local transcription now
  disables condition-on-previous-text by default (the primary driver of
  Whisper repetition loops on long podcasts) and exposes documented
  controls — `CASTRECALL_WHISPER_LANGUAGE`, `_OUTPUT_FORMAT`,
  `_WORD_TIMESTAMPS`, and no-speech/logprob/compression-ratio/
  hallucination-silence thresholds — mapped to each Whisper flavor's real
  CLI flags. Every option lands in applied-or-ignored provenance with a
  reason; nothing is silently dropped. Word timestamps only count as
  applied when the stored artifact (json) can carry them, the
  hallucination-silence guardrail applies regardless of output format
  (implicitly enabling the word-timestamp decode path it needs), and
  custom commands surface every bypassed control — including the
  loop-prevention default.
- **Exact generation provenance** (#54, PR #70): stored transcripts,
  setup/status, review candidates, and corpus exports now record the
  precise backend, model, model source (explicit/preset/backend-default),
  preset, output format, and applied/ignored decode settings — so
  `local-whisper:mlx-whisper` can never again hide a whisper-tiny corpus.
  Older stored provenance shapes render gracefully, never crashing review
  or export.

## v0.11.0 — 2026-07-06

Local-Whisper guardrails, part one: no more silently transcribing a corpus
with a toy model.

- **Explicit quality-ready model selection for MLX Whisper** (#51, PR #59):
  an installed `mlx_whisper` no longer counts as a usable backend by
  itself — upstream falls back to `whisper-tiny`, which is corpus-poison.
  Local MLX transcription now fails closed with a setup error unless
  `CASTRECALL_WHISPER_MODEL` names a model, a quality preset is set, or
  `CASTRECALL_WHISPER_ALLOW_LOW_QUALITY` explicitly opts into the upstream
  default. `castrecall_setup`/`castrecall_setup_status` name the concrete
  model before any corpus-scale run.
- **Apple Silicon quality presets** (#52, PR #65):
  `CASTRECALL_LOCAL_WHISPER_PRESET` gives mlx_whisper users a blessed
  path — `best`/`balanced` resolve to `mlx-community/whisper-large-v3-turbo`
  (the quality-approved corpus model today; `balanced` may diverge to a
  validated mid-tier later), `fast` is an explicit opt-in to
  `whisper-small-mlx`, never an accidental default. Presets satisfy #51's
  gate, are ignored with an explanatory reason on non-MLX Whisper flavors
  (`mlx-community/...` models don't run there), and
  `CASTRECALL_WHISPER_MODEL` always wins when both are set.

## v0.10.0 — 2026-07-06

The memory-curation lane closes the loop: review candidates can now be
resolved, with promotion always explicit and human-worded.

- **`castrecall_resolve_review`** (#1, PR #60): the conversation is the UI —
  an agent surfaces a pending review candidate in chat, you say what to
  keep, and the agent records the decision. `promote` requires `content`
  (the exact text you chose, written verbatim as a frontmattered note under
  `CASTRECALL_NOTES_DIR` with attribution but never the full transcript);
  `discard` writes nothing and retires the candidate. Either way the
  candidate moves `review/pending/` → `review/resolved/` and cannot be
  resolved twice. The gate is contractual: `castrecall_generate_review`
  remains structurally unable to promote anything.
- **Crash-safe resolution** (same PR, two review rounds): the
  pending→resolved move is link+unlink (never clobbers an existing resolved
  candidate), compensates a genuinely half-done move so retries can redo it,
  treats a concurrently-removed pending file as completion rather than
  deleting the only surviving copy, and rolls the move back if recording
  the disposition fails afterward — no path leaves an episode stranded
  without a recorded decision.

## v0.9.0 — 2026-07-06

Feed discovery gets a third leg: Listen Notes, used only as a verified
last resort.

- **Listen Notes feed-URL fallback** (#11, PR #49): with
  `LISTENNOTES_API_KEY` set, feed resolution falls back to Listen Notes'
  podcast search when both the Pocket Casts feed-export endpoint and
  iTunes Search miss. Never reached otherwise, and never called without a
  key.
- **Wrong-show protection** (same PR, review-driven): podcast titles are
  not unique, so a title match alone never selects a feed. Each
  title-matching candidate (bounded at 5) is verified by fetching its feed
  and requiring the listened episode's enclosure audio URL or GUID to
  match — the episode-title fallback is never sufficient — and ambiguous
  or unverifiable candidates fail closed rather than risk attaching
  another show's transcript. `resolveFeedItem` now reports which signal
  matched via `matchEvidence`.

## v0.8.0 — 2026-07-06

The first aggregate view: a cross-episode digest answering "what have I
been absorbing lately?"

- **`castrecall_digest`** (#4, PR #40): `{ days? }` looks across every
  episode whose listen was first seen in the window (default 30 days) and
  writes one structural document to `review/pending/digest-<window>.md` —
  the same approval-gated lane as review candidates, never auto-promoted.
  Heuristic aggregation only: episode/show counts, transcript-source
  breakdown, recurring topics by term frequency, and a handful of verbatim
  excerpts each attributed to its podcast and episode; a closing "For the
  reviewing agent" section hands actual synthesis to the reader. Re-running
  the same window reports `alreadyExists` instead of overwriting.
- **Untrusted-text hardening** (same PR, review-driven): transcript
  excerpts are blockquoted line-by-line across every Markdown line ending —
  LF, CRLF, and lone CR — so transcript-controlled text cannot break out of
  the quoted excerpt in the review document; untrusted titles stay
  JSON-escaped inside headings.

## v0.7.0 — 2026-07-06

The corpus becomes searchable: keyword and exact-phrase search over every
stored transcript, with attribution built into each hit.

- **`castrecall_search`** (#5, PR #38): `{ query, limit? }` runs
  keyword/quoted-phrase search over all stored transcripts. Every hit
  carries provenance (podcast, episode, listen date, transcript source,
  path) plus both a display `snippet` (`**term**`-highlighted, elided) and
  the verbatim `snippetText` slice it came from, so quoted material stays
  attributable to the transcript — never to a mutated string. Zero-score
  documents are excluded, not ranked low.
- **Index design hardened across seven review rounds** (same PR): ranking
  is settled entirely from a private, rebuildable on-disk index
  (`.index/search-index.v1.json`) — tf/idf-lite term scoring plus exact
  phrase confirmation from positional postings keyed by one-way term
  hashes, walked from the rarest phrase term. Exact phrase matches can
  never be hidden behind higher-scoring near-misses, no query shape can
  trigger a corpus-wide transcript scan (only the returned hits are read,
  for snippets), and the index never stores the transcript word sequence.
  The schema version lives in the filename, and wrong-version, corrupt, or
  structurally invalid entries self-heal on the next search.

## v0.6.1 — 2026-07-06

Marketplace-publish readiness (#8): no runtime changes, closes the gap
between what the plugin manifest claims and what actually ships.

- **Manifest/package version drift fixed and CI-guarded**: `openclaw.plugin.json`
  had been frozen at `0.3.0` since v0.1.0 while `package.json` moved on to
  `0.6.0` — ClawHub reads the manifest version, so publishing today would
  have listed a stale, misleading version. `npx openclaw plugins build
  --entry ./dist/index.js --check` now runs in CI right after the existing
  committed-`dist`-must-match-build guard, so the manifest can never drift
  from source again.
- **ClawHub publish spec finalized**: package renamed `castrecall` →
  `@comamitc/castrecall` (ClawHub plugin scope must match the publish owner);
  `openclaw.install.clawhubSpec` updated to `clawhub:comamitc/castrecall` to
  match the publish slug used in `clawhub package publish` and the release
  runbook. The plugin `id` (`castrecall`) is unchanged, so `openclaw plugins
  enable castrecall` and all tool names are unaffected.
- **Listing icon**: added `assets/icon.svg` (shipped via `package.json`
  `files`) and a manifest `icon` field pointing at its raw-GitHub URL —
  the only marketplace-card field ClawHub's plugin manifest supports.
- **Docs**: README documents the GitHub install path as current and the
  ClawHub path as pending publish/security review, adds a "Screenshots"
  section showing an example `castrecall_generate_review` candidate; new
  `docs/RELEASING.md` runbook covers version bump → manifest regen →
  packaging → tag → `clawhub package publish` → post-publish README flip.

## v0.6.0 — 2026-07-06

Event-driven transcript availability — delivered as bounded polling, because
an OpenClaw plugin has no reachable inbound endpoint for a literal webhook.

- **Transcript availability recheck** (#9, PR #35): a Taddy episode still
  being transcribed (`taddyTranscribeStatus`) or an RSS item with no
  transcript links declared yet is no longer a terminal miss. Those rungs
  now mark the episode recheckable, and a new `transcriptRecheck` state —
  sibling to the STT-billing `transcriptRetry` backoff — polls again on a
  capped exponential horizon until a hard age limit, after which the miss
  becomes terminal with an explicit "no transcript appeared" error.
  Scheduled runs defer episodes until the later of their retry/recheck
  eligibility times; `castrecall_setup_status` reports the pending-recheck
  count.
- **Manual STT recovery honored** (same PR, review-driven): once an
  episode's 5-attempt STT budget is spent, only *scheduled* runs keep
  skipping the paid rung. A direct `castrecall_fetch_transcript` call is
  explicit operator intent and re-attempts STT — exactly what the
  skipped-rung message advertises.

## v0.5.0 — 2026-07-06

A fifth transcript-ladder rung: Podchaser transcript lookup, hardened against
private-feed token disclosure.

- **Podchaser transcript rung** (#10, PR #33): with `PODCHASER_API_KEY` set
  (a pre-minted bearer access token from Podchaser's `requestAccessToken`
  exchange), the ladder checks Podchaser's GraphQL API between Taddy and
  local Whisper — a cheap transcript-lookup tier before any transcription
  runs. Two-hop lookup (episode by RSS GUID, falling back to exact-title
  search; then the short-lived transcript URL, normalized from
  beautified/raw JSON utterances), with every candidate validated against
  the resolved feed before it is trusted.
- **Trust-boundary hardening** (same PR, driven by five adversarial review
  rounds): nothing derived from the user's subscription feed ever crosses
  the Podchaser boundary. Feed URLs are used only for local candidate
  validation and are never transmitted (private/paid feeds embed subscriber
  tokens in userinfo, query, fragment, or path — unprovably public);
  RSS GUIDs are sent only when provably opaque, with URL-like GUIDs —
  including percent-encoded and double-encoded structure — falling back to
  title-only search. Regression matrix asserts no request body ever
  contains a token in any position.

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
