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
- [ ] #15 contract hardening (prereq of #14) — pipeline → merge
- [ ] #14 corpus-export mode — pipeline → merge (after #15)
- [ ] #16 README positioning — pipeline → merge
- [ ] release v0.1.0 → tag, close milestone

### v0.2.0 — freshness & onboarding
- [ ] #3 periodic sync · [ ] #2 setup flow · [ ] release v0.2.0

### v0.3.0 — robustness
- [ ] #7 credentials · [ ] #6 retry/backoff · [ ] release v0.3.0

### v0.4.0–v0.9.0 — ladder breadth & distribution
- [ ] #13, #12 → v0.4.0 · [ ] #10 → v0.5.0 · [ ] #9 → v0.6.0 · [ ] #8, #5 → v0.7.0 · [ ] #4 → v0.8.0 · [ ] #11 → v0.9.0 (release after each)

### v0.10.0 — memory-curation lane
- [ ] #1 review disposition tool · [ ] release v0.10.0

## Dependencies (verified)
- #15 → #14 (content hash before export idempotency). No other hard edges.

## Blockers
- (none)

## Merge/release log
- PR #17 (roadmap doc) squash-merged to main — setup, not a roadmap issue.
