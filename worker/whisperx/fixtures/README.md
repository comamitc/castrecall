# Shared wire-contract fixtures

These JSON files are example responses from a running
`castrecall-whisperx-worker`, in the exact shape CastRecall's `remote-stt`
provider (`src/transcripts/remote-stt.ts`) expects. They are the single
shared artifact consumed by **both**:

- `worker/whisperx/tests/` (pytest) — sanity-checks the worker's own
  normalization logic produces this shape.
- `src/transcripts/remote-stt-worker-contract.test.ts` (vitest, CI-gated) —
  replays each fixture through `transcribeWithRemoteStt` with a fake
  `fetchImpl`, proving CastRecall parses this worker's real response shapes
  correctly.

If the worker's response shape ever changes, update these fixtures — the
Node contract test will fail if they drift from what `remote-stt.ts` can
parse.

| File | Scenario |
| --- | --- |
| `health.json` | `GET /health` |
| `sync_result.json` | `POST /transcribe` returning an inline (non-job) result |
| `async_submit.json` | `POST /transcribe` returning `{job_id, status: "queued"}` |
| `job_completed.json` | `GET /jobs/{id}` once the async job finishes |
| `job_completed_trailing_slash.json` | Same, used to assert a trailing-slash base URL still parses |
| `job_failed.json` | `GET /jobs/{id}` for a terminally failed job |
| `empty_result.json` | A result with neither `text` nor `segments` — must throw |
