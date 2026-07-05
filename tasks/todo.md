# CastRecall Review and Fix Plan

## Context

- Goal: review the completed CastRecall OpenClaw plugin against the product brief and Claude build prompt, fix safe defects, verify, commit, and push directly to `origin/main`.
- Branch: `main`.
- Worktree note: user explicitly requested direct `main` work, which conflicts with the shared contract's worktree rule; direct `main` work is being used for this run.

## Plan

- [x] Read shared operating contract, local guidance, existing lessons, and confirm branch/remote state.
- [x] Pull latest `origin/main`.
- [x] Read product context, original build prompt, README, package metadata, plugin metadata, source layout, tests, and recent commits.
- [x] Inspect OpenClaw plugin CLI expectations (`plugins build`, `plugins validate`, install/list/inspect smoke paths).
- [x] Run baseline verification: dependency install, typecheck/build, tests, plugin build, plugin validate, and safe tool/status commands.
- [x] Review implementation for OpenClaw compatibility, credential safety, read-only Pocket Casts behavior, transcript ladder correctness, storage/idempotency, and approval-gated review behavior.
- [x] Fix concrete defects with targeted changes and meaningful tests.
- [x] Regenerate generated plugin metadata with project commands.
- [x] Update README, `.env.example`, and docs where behavior or setup differs.
- [x] Re-run full verification, including local install smoke test if safe.
- [x] Commit cohesive fixes on `main`, push to `origin/main`, and verify the remote branch tip.

## Review Notes

- Fixed public install packaging: `dist/` is now intended to be committed, package artifact includes docs and `.env.example`, README uses OpenClaw's working `git:github.com/...@ref` syntax, and `package.json#openclaw` now declares install and compatibility metadata.
- Fixed approval-gate leak: `castrecall_fetch_transcript` no longer returns transcript excerpts directly; it only returns paths/status and points callers to `castrecall_generate_review`.
- Fixed review URL hygiene: model-facing review markdown strips query strings and fragments from provenance URLs while retaining full URLs in `provenance.json`.
- Fixed RSS transcript edge cases: namespace alias tags, relative transcript URLs, `text/srt` format preference, VTT files whose first cue follows the header directly, common JSON transcript shapes, and SRT speaker labels.
- Fixed state drift: when transcript files already exist, `castrecall_fetch_transcript` repairs the episode state to `stored` so bulk review generation can pick it up.
- Final verification passed: `npm install`, `npm run typecheck`, `npm run build`, `npm test` (40 tests), `openclaw plugins build --root . --entry ./dist/index.js --check`, `openclaw plugins validate --root . --entry ./dist/index.js`, `npm pack --dry-run --json`, direct setup-status smoke without credentials, linked install smoke, and `npm-pack:` install smoke.
