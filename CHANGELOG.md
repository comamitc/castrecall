# Changelog

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
