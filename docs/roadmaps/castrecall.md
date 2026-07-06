# CastRecall Backlog Roadmap

> Generated 2026-07-05 by `pipeline roadmap`, then manually re-ranked: the engine's risk-weighted order was overridden per product priority. CastRecall's main purpose is building a transcript dataset that markdown-brain tooling (gbrain LSD/brainstorm and similar) can consume, so the corpus-feed lane leads. Milestones below are applied on GitHub.

## Ranked order

### v0.1.0 — corpus feed (product core)

1. **#15** Data-dir contract hardening: content hash, versioned schema, stable IDs — *prerequisite of #14*
2. **#14** Corpus-export mode: emit markdown pages for gbrain and other markdown brains — *flagship*
3. **#16** README: position CastRecall as a raw-source pipeline for markdown brains — *ships with #14*

### v0.2.0 — freshness & onboarding

4. **#3** Periodic history sync (scheduled/background) — keeps the corpus alive
5. **#2** First-run guided setup flow

### v0.3.0 — robustness

6. **#7** Credential handling beyond plaintext env vars
7. **#6** Retry/backoff behavior in the Pocket Casts adapter

### v0.4.0–v0.9.0 — ladder breadth & distribution

8. **#13** Platform-caption sources (Apple/Pocket Casts) — v0.4.0, investigated and closed as **no-go** (no ladder rung shipped); see `docs/transcript-source-investigation.md`
9. **#12** STT: Deepgram provider — v0.4.0
10. **#10** Podchaser provider — v0.5.0
11. **#9** Taddy webhooks — v0.6.0 — shipped as a scheduled-polling substitute (no reachable inbound endpoint exists for a literal webhook in the OpenClaw plugin model); see `docs/ARCHITECTURE.md`'s "Event-driven transcript availability" section
12. **#8** Publish to ClawHub / marketplace — v0.7.0
13. **#5** Search over the private transcript corpus — v0.7.0
14. **#4** Cross-episode digest — v0.8.0
15. **#11** Listen Notes discovery fallback — v0.9.0

### v0.10.0 — memory-curation lane

16. **#1** Review disposition tool: conversational approval, explicit promotion

### v0.11.0–v0.13.0 — transcript quality track (added 2026-07-06)

17. **#42** Detect Whisper repetition loops and quarantine bad transcripts — v0.11.0 (bug; its detector feeds #41's scoring)
18. **#41** Transcript quality scoring in stored provenance — v0.11.0
19. **#43** Timestamped transcript segments through storage and corpus export — v0.12.0
20. **#44** Speaker metadata and diarization across transcript sources — v0.12.0 (speaker turns ride on #43's segments)
21. **#45** Transcript cleanup pass (punctuation, sentence boundaries, formatting) — v0.13.0
22. **#46** Optional proper-noun correction glossary — v0.13.0 (plugs into #45's cleanup pass)

### v0.14.0–v0.16.0 — local-Whisper quality track (added 2026-07-06)

23. **#51** Require explicit quality-ready model selection for MLX Whisper — v0.14.0 (bug; fail closed instead of silently using whisper-tiny)
24. **#52** Apple Silicon local transcription preset (MLX large-v3-turbo) — v0.14.0 (the blessed way to satisfy #51's gate)
25. **#53** Loop-safe Whisper decoding options for local transcription — v0.15.0
26. **#54** Persist exact local provider, model, and decode settings in provenance — v0.15.0 (records the settings #52/#53 introduce)
27. **#55** Corpus-scale transcription preflight and quality warning — v0.16.0 (summarizes the #51–#53 config surface)
28. **#56** Document local Whisper model requirements — v0.16.0 (docs last, covering the whole track)

## Notes

- Acceptance criteria exist on the v0.1.0/v0.2.0 issues (#15, #14, #16, #3, #2); remaining short tickets get specs via intake when they approach the front of the queue.
- Only verified dependency in the original set: **#15 → #14** (content hash before export idempotency).
- Quality-track ordering dependencies: **#42 → #41**, **#43 → #44**, **#45 → #46** (each first issue provides the mechanism its successor consumes).
- Local-Whisper track ordering dependencies: **#51 → #52**, **#53 → #54**, **#55 → #56** (gate before preset, settings before provenance, features before docs).
