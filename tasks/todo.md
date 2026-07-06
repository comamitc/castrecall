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
- [x] #12 Deepgram STT — PR #31 squash-merged, issue closed. One pre-merge block (two findings): bounded/backed-off transient STT retries (per-episode `transcriptRetry`, 5-attempt budget → terminal failed; pipeline defers until eligible) and network-level Deepgram rejections converted to RetryableSttError. 257 tests green.
- [x] release v0.4.0 — PR #32 merged, version 0.3.0→0.4.0, tag pushed, GitHub release published, milestone closed.
- [x] #10 Podchaser transcript rung — PR #33 squash-merged, issue closed. FIVE pre-merge review rounds, all privacy/trust-boundary: stale dist; feed URL sent to Podchaser (tokenized private feeds) → guard; path-embedded tokens → feed URL never transmitted (local-only scoping); URL-like RSS GUIDs → opaque-GUID gate; percent-encoded structure → bounded-decode classification. 283 tests green.
- [x] release v0.5.0 — PR #34 merged, version 0.4.0→0.5.0, tag pushed, GitHub release published, milestone closed.
- [x] #9 Taddy webhooks (as polling recheck) — PR #35 squash-merged, issue closed. Three pre-merge rounds: implementation review approved; dist drift after review-fix commits (rebuilt); manual-recovery finding — spent STT retry budget now gates scheduled runs only, a direct `castrecall_fetch_transcript` call re-attempts STT as the skipped-rung message advertises (+ regression test). 307 tests green on main.
- [x] release v0.6.0 — PR #36 merged, version 0.5.0→0.6.0, tag pushed, GitHub release published, milestone closed.
- [ ] #8 ClawHub publish readiness — NOT complete; issue stays open until the ClawHub
      listing is actually live and installable. Readiness work (metadata/CI-only) is done and
      shipped standalone as v0.6.1 rather than bundled into v0.7.0 (0.6.0 was already tagged; a
      fresh patch gives a clean, internally consistent pinnable release): manifest version drift
      fixed (was frozen at 0.3.0 since v0.1.0 while package.json moved on) and CI-guarded via
      `openclaw plugins build --check` sibling to the existing dist-diff guard; package renamed
      `castrecall`→`@comamitc/castrecall` (plugin `id` unchanged); `assets/icon.svg` + manifest
      `icon` field; a review-flow screenshot; `docs/RELEASING.md` runbook. Still blocking:
      `clawhub package publish` + post-publish README flip (see docs/RELEASING.md and the
      release line below) — close #8 only once those have happened and the listing is verified
      installable.
- [ ] release v0.6.1 (maintainer: tag, gh release, then `clawhub package publish` + README flip)
- [ ] #5 → v0.7.0 · [ ] #4 → v0.8.0 · [ ] #11 → v0.9.0 (release after each)

> HANDOFF 2026-07-06: goal ended on the original machine after v0.5.0. #9's pipeline run was stopped at worktree setup (no work produced) and the issue reset to `pipeline:ready`; its local worktree/branch were removed. Resumed from #9 on the new machine 2026-07-06.

#### #9 Taddy webhooks (event-driven transcript availability) — implementation checklist

Conflict: CastRecall is an OpenClaw plugin with no reachable inbound endpoint — a literal
webhook can't ship. Delivering the issue's own stated fallback instead: scheduled polling of
Taddy's `taddyTranscribeStatus` plus an RSS "transcript may appear later" re-check, via a new
`transcriptRecheck` sibling to the existing `transcriptRetry` STT-billing backoff.

- [x] `taddy.ts`: `fetchTaddyTranscript` returns `TaddyLookup` (`hit`/`pending`/`miss`) instead of
      `TaddyTranscript | undefined`; read `taddyTranscribeStatus`; `isTranscribingStatus` allowlist
      match with `NOT_TRANSCRIBING`-substring negation guard
- [x] `ladder.ts`: `RungOutcome.recheckable?: boolean`; Taddy `pending` → recheckable miss rung; RSS
      "no transcript links declared" → recheckable miss rung
- [x] `storage.ts`: `ListenRecord.transcriptRecheck` (additive), `TRANSCRIPT_RECHECK_BASE_MS` /
      `_CAP_MS` / `_MAX_AGE_MS` constants
- [x] `tools.ts`: `fetchTranscript` middle case between retryable and terminal-failed; `retryable`
      still checked first (billing precedence); `livePipelineErrors` folds recheck
      `nextEligibleAt`; `setupStatus` gets `transcriptsPendingRecheck` count
- [x] `pipeline.ts`: gate defers until `max(transcriptRetry, transcriptRecheck)` eligible time
- [x] Tests: new `src/transcripts/taddy.test.ts` (13 tests); `tools.test.ts` recheck/horizon/precedence
      cases (+5); `pipeline.test.ts` defer/resume + dual-gate + RSS-horizon cases (+3)
- [x] Docs: README Scheduled-sync section (webhook infeasibility + polling substitute + RSS
      horizon trade-off) + ladder section note; `docs/ARCHITECTURE.md` new "Event-driven transcript
      availability" subsection + three-backoff-layers update; roadmap doc annotated
- [x] `npm run typecheck && npm run build && npm test` green (303/303, was 283)
- [x] Review section appended below

##### Review

- `npm run typecheck`: pass. `npm run build`: pass. `npm test`: **303/303 passed** (was 283 before
  this change; +20: 13 in new `taddy.test.ts`, 5 in `tools.test.ts` (recheck-then-store, horizon
  terminal-failure, non-recheckable-miss regression, retryable-beats-recheckable precedence — plus
  the recheck/horizon defer-resume pair counted individually), 3 in `pipeline.test.ts`
  (defer/resume, RSS-horizon, dual-gate).
- Design: `transcriptRecheck` is a sibling field to `transcriptRetry`, not a reuse — kept separate
  so `transcriptRetry`'s paid-STT billing cap is never blurred with the recheck horizon's
  futile-poll bound. `fetchTranscript` checks `retryable` before `recheckable`, so a transient STT
  failure always wins over an availability-pending miss (asserted by a dedicated dual-signal test).
  `isTranscribingStatus` is an explicit `{PROCESSING, TRANSCRIBING}` allowlist with a negated
  substring fallback, because `NOT_TRANSCRIBING` (Taddy's real terminal-state enum value) contains
  the substring `TRANSCRIBING` and would otherwise be misclassified as pending.
- Conflict surfaced and documented: the issue asks for a literal Taddy webhook, which cannot ship
  in CastRecall's architecture (OpenClaw tool plugin, no reachable inbound HTTP endpoint). Shipped
  the issue's own stated fallback (scheduled polling) instead, and documented why in both README
  and ARCHITECTURE.md, with the recheck/`transcriptRecheck` machinery noted as the landing point
  for a real webhook handler if OpenClaw ever exposes inbound HTTP to plugins.
- No dist regressions: `fetchTaddyTranscript`'s new discriminated-union return type only changes
  its one caller (`ladder.ts`'s Taddy rung); `RungOutcome.recheckable` and
  `ListenRecord.transcriptRecheck` are both additive optional fields.

#### #10 Podchaser transcript rung — implementation checklist
- [x] `resolveConfig` resolves `PODCHASER_API_KEY` into `config.podchaser.apiKey` (empty string → undefined)
- [x] `podchaserConfigured(config)` true iff apiKey set
- [x] `src/transcripts/podchaser.ts`: two-hop GraphQL lookup (GUID → title exact-match) + transcript-URL fetch + normalize (beautified_JSON object / raw_JSON array)
- [x] `CastrecallSetupError` on 401/403 GraphQL; plain `Error` on other non-ok GraphQL and non-ok transcript-URL fetch; no token in any thrown message
- [x] Unrecognized/whitespace transcript shape → miss (undefined), not a throw
- [x] `ladder.ts`: new Rung 3 "podchaser" between taddy and local-whisper; skip/hit/miss/failed outcomes; header doc + rung renumbering
- [x] `storage.ts`: add `"podchaser"` to `transcriptSource` union
- [x] `setup.ts`: `providers.podchaser` step between taddy and localWhisper
- [x] `tools.ts`: `transcriptLadder.podchaser` status string
- [x] Tests: `podchaser.test.ts` (new, 13 tests), extend `config.test.ts`, `setup.test.ts`, `tools.test.ts`
- [x] Docs: `.env.example`, `README.md` (list/table/ladder line/troubleshooting), `docs/ARCHITECTURE.md` (file tree, data flow, transcriptSource union) — note bearer-token semantics
- [x] `npm run typecheck && npm run build && npm test` green; `dist/transcripts/podchaser.js` emitted
- [x] Verification/review section appended below

##### Review
- `npm run typecheck`: pass. `npm run build`: pass, `dist/transcripts/podchaser.js` + `.d.ts` emitted. `npm test`: **274/274 passed** (was 257 before this change; +17: 13 in `podchaser.test.ts`, 2 in `config.test.ts`, 1 in `setup.test.ts` flip test, 1 new `tools.test.ts` podchaser-hit case; existing ladder-skip/setup-order/status tests extended in place).
- Design decisions: `PODCHASER_API_KEY` is documented (not silently assumed) as a pre-minted bearer access token, matching the issue's single-secret contract without adding undisclosed config. The rung mirrors Taddy's GUID→title fall-through loop but adds a second hop (fetch the ~10-min transcript URL, normalize `beautified_JSON`/`raw_JSON` shapes) per `rss.ts`'s fetch-and-normalize precedent. Placed above local Whisper per the issue (cheap transcript-lookup tier, same reasoning as Taddy — not the "local before paid cloud STT" rule, which governs the transcription tier below).
- No dist regressions: only additive rung insertion; `ladder.ts`/`config.js`/`setup.js`/`tools.js`/`storage.d.ts` diffs are the renumbering + new field/step, no unrelated changes.

### v0.10.0 — memory-curation lane
- [ ] #1 review disposition tool · [ ] release v0.10.0

## Dependencies (verified)
- #15 → #14 (content hash before export idempotency). No other hard edges.

## Blockers
- (none)

## Merge/release log
- PR #17 (roadmap doc) squash-merged to main — setup, not a roadmap issue.
