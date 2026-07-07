# castrecall-whisperx-worker (reference implementation, issue #62)

An **optional** self-hosted speech-to-text worker that runs [WhisperX](https://github.com/m-bain/whisperX)
behind CastRecall's generic remote STT contract. It exists for power users
with their own NVIDIA/CUDA hardware who want high-quality private
transcription without forking CastRecall or writing a one-off
machine-specific script.

**Nothing here is required to use CastRecall.** Every other transcript
ladder rung (RSS, Taddy, Podchaser, local Whisper on CPU/Apple Silicon,
AssemblyAI/OpenAI/Deepgram) works exactly as documented in the root
[`README.md`](../../README.md) with no GPU and no knowledge that this
directory exists. Point CastRecall at this worker only if you already have
a CUDA machine and want to run WhisperX yourself.

## What this is

A standalone FastAPI service, deployed with Docker, that implements the
`remote-stt` contract CastRecall's `src/transcripts/remote-stt.ts` actually
speaks (normative source — this worker is written against that file, not
against issue prose). Point CastRecall at it with environment variables
only; **no CastRecall source changes required.**

## Canonical paths vs. the issue's `/v1/...` names

CastRecall's `remote-stt` provider calls exactly these paths — configure
`CASTRECALL_REMOTE_STT_BASE_URL` at the host:port below, with **no path
suffix**:

| Canonical (CastRecall calls these) | Purpose |
| --- | --- |
| `GET  {base}/health` | readiness probe: `200` (with `implementation`, `version`, `model`, `model_ready`, `capabilities: { diarization, timestamps }`, `accepts: "both"`) only once CUDA is available and the configured model loads; `503` otherwise. Read by CastRecall's tri-state setup/status checks (issue #63) — see root README "Remote STT contract". |
| `POST {base}/transcribe` | submit |
| `GET  {base}/jobs/{job_id}` | poll status; `result` field once completed |

Issue #62 additionally names `POST /v1/transcriptions`, `GET
/v1/jobs/{id}`, and `GET /v1/jobs/{id}/result`. This worker mounts those too
— as **aliases that route to the exact same handlers** — purely so the
worker also honors the issue's literal wording for humans/curl following it.
**CastRecall itself never calls `/v1/...`.** Point `CASTRECALL_REMOTE_STT_BASE_URL`
at the plain worker host/port; do not add a `/v1` suffix.

`GET /v1/jobs/{id}/result` is the one endpoint with no canonical
equivalent: it returns the bare normalized `result` object directly
(instead of wrapped in `{status, result}`), and 404s until the job
completes.

## Every endpoint requires a bearer token

`WORKER_TOKEN` is **required** — the worker refuses to start at all if it's
unset. Every route, including `/health`, requires:

```
Authorization: Bearer <WORKER_TOKEN>
```

This is safe with CastRecall's health probe: `remoteSttHealth` in
`remote-stt.ts` already sends the bearer on its `/health` call, so an
authenticated health endpoint costs nothing. A missing/incorrect token
returns `401` on every route and never includes any result data.

## Version matrix

WhisperX's dependency chain (torch/ctranslate2/pyannote) is fragile across
version bumps — this combination is the one this worker is built and tested
against:

| Component | Version |
| --- | --- |
| Base image | `nvidia/cuda:12.4.1-cudnn-runtime-ubuntu22.04` |
| Python | 3.11 |
| `torch` | 2.4.1 (cu124 wheels) |
| `whisperx` | 3.3.1 |
| `fastapi` / `uvicorn` / `python-multipart` | pinned in `requirements.txt` |

Bumping any of these without testing the full install (`pip install -r
requirements.txt` inside the pinned base image) is likely to break — WhisperX
has a history of incompatible torch/ctranslate2 pairings.

## Deploy (Docker-first, CUDA host required)

```bash
cd worker/whisperx
cp .env.example .env
# edit .env: set WORKER_TOKEN (openssl rand -hex 32), review model/diarize defaults

docker compose up -d --build
curl -H "Authorization: Bearer $WORKER_TOKEN" http://127.0.0.1:8000/health
```

`docker-compose.yml` requests one GPU (`deploy.resources.reservations.devices`)
and publishes the port to `127.0.0.1` **on the host** only — see "Network
exposure" below for reaching it from CastRecall on another machine.

## Network exposure (private network / Tailscale)

The worker binds `127.0.0.1` by default (`WORKER_BIND_HOST`) and
`docker-compose.yml` further restricts the published port to the host's own
loopback interface. It is never intended to sit on a public interface — a
GPU transcription endpoint is expensive to abuse even with a token. To reach
it from the machine running CastRecall:

- **Same machine:** point `CASTRECALL_REMOTE_STT_BASE_URL=http://127.0.0.1:8000`
  directly.
- **Tailscale / private network:** run `tailscale serve` (or an SSH tunnel)
  on the worker host to forward the loopback port onto your tailnet/private
  network, then point CastRecall at that tailnet address. Do not change
  `WORKER_BIND_HOST`/the compose port publish to a public interface as a
  shortcut — forward the loopback port instead, so the worker is never
  directly reachable from the public internet regardless of firewall
  misconfiguration elsewhere.

## Configure CastRecall (no source changes)

In CastRecall's own `.env` (see the root `.env.example`'s remote-stt
section):

```bash
CASTRECALL_ENABLE_STT=true
CASTRECALL_STT_PROVIDER=remote-stt
CASTRECALL_REMOTE_STT_BASE_URL=http://<worker-host>:8000
CASTRECALL_REMOTE_STT_TOKEN=<the same WORKER_TOKEN>
```

That's it — `castrecall_setup`/`castrecall_setup_status` will show the
worker's reported `implementation`/`model` from `/health`, and every
transcript produced this way carries `generation.kind: "remote-stt"`,
`generation.implementation: "whisperx"`, and `generation.baseUrlHost` set to
the worker's host (never the token or full base URL) in `provenance.json`.

## Request options

`POST /transcribe` (and its `/v1/transcriptions` alias) accepts JSON:

```json
{
  "audio_url": "https://example.com/episode.mp3",
  "model": "large-v3",
  "language": "en",
  "batch_size": 16,
  "compute_type": "float16",
  "timestamps": true,
  "diarize": false
}
```

...or `multipart/form-data` with a `file` field plus the same fields as
form values (used automatically by CastRecall when
`CASTRECALL_REMOTE_STT_UPLOAD=true`). Every field is optional except one of
`audio_url`/`file`; omitted fields fall back to the worker's own
`WHISPERX_*` env defaults (see `.env.example`).

`diarize: true` without `HF_TOKEN` configured does not fail the job — it
returns the transcript without speaker labels plus a `warnings` entry, since
a transcript with no diarization is still useful.

## Persistence limitation (read before relying on this in production)

Jobs live **in memory only** — a worker restart loses every in-flight and
completed-but-unpolled job. This is a reference implementation for a single
operator's own hardware, not a durable production queue. If you need
restart-safe job state, put a real queue/database in front of
`whisperx_backend.transcribe()` yourself; that function is the one seam
meant to be swapped or wrapped.

## Backpressure

A single GPU can usefully run one WhisperX transcription at a time by
default (`MAX_ACTIVE_JOBS=1`). Jobs queued or processing beyond
`MAX_QUEUED_JOBS` (default 16) are rejected with `429` — CastRecall's
`remote-stt` provider already classifies `429` as retryable
(`isRetryableHttpStatus` in `src/transcripts/stt.ts`), so a busy worker
naturally defers the episode instead of failing it.

`MAX_QUEUED_JOBS` only bounds how many jobs may be *waiting*; downloading a
job's `audio_url` is deferred until `MAX_ACTIVE_JOBS` actually admits it, so
at most `MAX_ACTIVE_JOBS` audio downloads ever run concurrently — not up to
`MAX_QUEUED_JOBS` of them. A multipart file upload is streamed straight to
disk as it's received instead of buffered in memory. The queue-full check
reserves capacity *before* the request body is read at all, so a full
queue rejects a submission without staging any bytes to disk first.

## Audio size limit

`MAX_AUDIO_BYTES` (default 2 GiB) bounds how much audio a single job may
stage on disk, whether uploaded or downloaded from `audio_url`. A multipart
upload over the limit aborts the stream and returns `413` immediately. An
`audio_url` download over the limit aborts the stream and fails the job
instead (the submit request has already returned `200 queued` by the time
the download runs), so poll `/jobs/{job_id}` to see the failure.

## Outbound audio_url safety

Podcast enclosure URLs can come from a feed publisher CastRecall doesn't
control. By default, `audio_url` (and every redirect target it leads to) is
rejected if it resolves to a loopback, private, link-local, multicast,
or reserved address — otherwise a malicious/compromised feed could use this
worker's own network access to reach internal services on the machine or
network it runs on (metadata endpoints, other Tailscale-only hosts, etc).
Only `http`/`https` are accepted. Set `ALLOW_PRIVATE_AUDIO_URLS=true` only
if you deliberately host audio internally and trust every `audio_url` this
worker will ever receive.

## Completed job retention

`MAX_COMPLETED_JOBS` (default 200) bounds how many completed/failed jobs
stay queryable in memory at once — the oldest are evicted first once the
cap is exceeded, so a long-running worker doesn't retain every past
transcript forever. Polling a job past its retention window returns `404`,
same as an unknown job id.

## Running the tests without a GPU

`whisperx_backend.py` imports the real `whisperx` package lazily (inside
`transcribe()`, not at module scope), so the entire pytest suite runs with
the backend mocked — no GPU, no CUDA, no WhisperX/torch installation needed:

```bash
cd worker/whisperx
python3.11 -m venv .venv && source .venv/bin/activate
pip install -r requirements-test.txt
pytest tests
```

## Smoke test (one public audio URL)

Once the worker is running and reachable:

```bash
WORKER_TOKEN=<your token> ./smoke.sh https://example.com/some-public-episode.mp3 http://<worker-host>:8000
```

This submits the URL, polls `/jobs/{id}` until `completed`, and prints the
normalized transcript JSON. Requires `curl` and `jq`.

## Files

| File | Purpose |
| --- | --- |
| `app.py` | FastAPI routes, auth, job queue/backpressure, request parsing |
| `whisperx_backend.py` | The one WhisperX-calling function; isolated so it's mockable |
| `config.py` | Env → `Settings`, fails closed without `WORKER_TOKEN` |
| `Dockerfile` / `docker-compose.yml` | CUDA-host container build/run |
| `requirements.txt` / `requirements-test.txt` | Pinned runtime deps / mock-backend test deps |
| `smoke.sh` | One-URL curl smoke test |
| `tests/` | pytest suite (backend mocked) |
| `fixtures/` | Example wire-contract responses, shared with CastRecall's Node contract test |
