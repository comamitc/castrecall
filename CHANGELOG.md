# Changelog

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
