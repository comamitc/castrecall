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
11. **#9** Taddy webhooks — v0.6.0
12. **#8** Publish to ClawHub / marketplace — v0.7.0
13. **#5** Search over the private transcript corpus — v0.7.0
14. **#4** Cross-episode digest — v0.8.0
15. **#11** Listen Notes discovery fallback — v0.9.0

### v0.10.0 — memory-curation lane

16. **#1** Review disposition tool: conversational approval, explicit promotion

## Notes

- Acceptance criteria exist on the v0.1.0/v0.2.0 issues (#15, #14, #16, #3, #2); remaining short tickets get specs via intake when they approach the front of the queue.
- Only verified dependency: **#15 → #14** (content hash before export idempotency).
