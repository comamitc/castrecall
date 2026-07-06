# CastRecall Roadmap Execution — autonomous pipeline run

Goal: drive all 16 roadmap issues through `/pipeline` to merge on `main`, cutting a release when each milestone empties. Started 2026-07-05. (Previous todo — the 2026-07-04 review-and-fix plan — completed in full; see commit 243d25c.)

## Order (milestone-driven; matches docs/roadmaps/castrecall.md)

Note: the goal text's "roadmap order" (#7 first) was the stale engine ranking; the roadmap file, milestone membership, and the verified #15→#14 dependency all agree on corpus-feed first. Following milestone order.

## Setup (done)

- [x] Read agent contract, lessons.md, pipeline SKILL.md
- [x] Doctor preflight: PASS (fixed: checkout stranded on roadmap branch → main; stale node_modules → npm ci)
- [x] Merged PR #17 (roadmap doc → docs/roadmaps/castrecall.md on main, CI green)
- [x] All 16 issues triaged to `pipeline:ready`

## Execution queue

### v0.1.0 — corpus feed
- [x] #15 contract hardening — PR #18 squash-merged (4593d02), issue closed. Two pre-merge review rounds: staging moved to `.staging/` namespace + dist rebuilt with CI freshness guard (1cdce18); completeness-contract wording + untracked-dist check (fb0138e). 60 tests green.
- [x] #14 corpus-export mode — PR #19 squash-merged, issue closed. One transient plan-review timeout (retried). 89 tests green on main.
- [x] #16 README positioning — PR #20 squash-merged (0 review findings), issue closed.
- [x] release v0.1.0 — PR #21 merged, tag v0.1.0 pushed, GitHub release published, milestone closed. NOTE: `pipeline release` is agent-pipeline-repo-specific (expects core/package.json + plugin/ mirror); used equivalent gated flow (release PR → CI → merge → tag → gh release → close milestone). Also found launcher bug: injected --profile is rejected by the release subcommand's flag allowlist.

### v0.2.0 — freshness & onboarding
- [x] #3 periodic sync — PR #22 squash-merged after EIGHT pre-merge review rounds. Final design: `castrecall_run_pipeline` (sync → transcripts → hash-idempotent self-healing export pass → reviews, all worklists from durable state), FAIL-CLOSED run lock (exclusive-create + touch-only heartbeat renewal + zero auto-reclaim; explicit breakStaleLock recovery serialized behind an unstealable mutex that scheduled acquirers also observe), capped-backoff cooldown, structured pipelineErrors + lock health in setup_status. 121 tests green on main.
- [x] #2 setup flow — PR #23 squash-merged (castrecall_setup tool; one review round: shared whisper readiness predicate + dist rebuild), issue closed.
- [x] release v0.2.0 — PR #25 merged, version 0.1.0→0.2.0, tag pushed, GitHub release published, milestone closed.

### v0.3.0 — robustness
- [x] #7 credentials — PR #26 squash-merged, issue closed. OS keychain (macOS/libsecret) for credentials + session-token records; three review rounds hardened token-cache concurrency (captured entries, flight-joiner persistence upgrade, serialized durable writes). 201 tests green.
- [x] #6 retry/backoff — PR #27 squash-merged in one clean pipeline run (0 pre-merge blocks), issue closed.
- [x] #24 listened-episode filter — PR #28 squash-merged in one clean pipeline run (0 pre-merge blocks), issue closed. New `src/pocketcasts/listened.ts`; 241 tests green on main.
- [x] release v0.3.0 — PR #29 merged, version 0.2.0→0.3.0, tag pushed, GitHub release published, milestone closed.

### v0.4.0–v0.9.0 — ladder breadth & distribution
- [x] #13 platform-caption sources (Apple/Pocket Casts) — investigation-only, **no-go**: `docs/transcript-source-investigation.md`. Pocket Casts' generated transcripts are a real second source beyond RSS, reachable through a stable, unauthenticated, community reverse-engineered endpoint (`podcast-api.pocketcasts.com/show_notes/full`) — but that same lack of auth means using it would bypass Pocket Casts' Plus/Patron paywall rather than merely depend on an unofficial API; Apple's transcript API requires reverse-engineered cryptographic request signing with no documented access path. Runtime ladder unchanged (still 4 rungs).
- [ ] #12 → v0.4.0 · [ ] #10 → v0.5.0 · [ ] #9 → v0.6.0 · [ ] #8, #5 → v0.7.0 · [ ] #4 → v0.8.0 · [ ] #11 → v0.9.0 (release after each)

### v0.10.0 — memory-curation lane
- [ ] #1 review disposition tool · [ ] release v0.10.0

## Dependencies (verified)
- #15 → #14 (content hash before export idempotency). No other hard edges.

## Blockers
- (none)

## Merge/release log
- PR #17 (roadmap doc) squash-merged to main — setup, not a roadmap issue.
