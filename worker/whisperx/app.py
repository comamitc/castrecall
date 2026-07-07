"""Reference WhisperX remote STT worker (issue #62).

Implements the generic remote STT contract CastRecall's `remote-stt`
provider actually speaks (`src/transcripts/remote-stt.ts`, mirrored in the
root README's "Remote STT contract"):

    GET  {base}/health              -> readiness probe, never a hard failure
    POST {base}/transcribe          -> submit (JSON audio_url, or multipart file)
    GET  {base}/jobs/{job_id}       -> poll: queued -> processing -> completed | failed

`/v1/transcriptions` and `/v1/jobs/{job_id}` (+ `/v1/jobs/{job_id}/result`)
are additive aliases honoring the issue's literal endpoint names — they
route to the exact same handlers. CastRecall itself is configured against
the canonical paths above; the `/v1/...` names exist for humans/curl
following the issue text, not because CastRecall calls them.

Every route requires `Authorization: Bearer <WORKER_TOKEN>`, including
`/health` — CastRecall's own health probe already sends the bearer
(`remoteSttHealth`, `remote-stt.ts`), so this is safe. The worker refuses to
start at all when `WORKER_TOKEN` is unset (see `config.load_settings`).

Jobs live in an in-memory dict — lost on restart. This is a reference
worker, not a durable production queue; see the README's persistence
caveat.
"""

from __future__ import annotations

import asyncio
import hmac
import tempfile
import uuid
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any, Optional

import httpx
from fastapi import FastAPI, HTTPException, Request

from config import Settings, load_settings
from whisperx_backend import TranscribeOptions
from whisperx_backend import transcribe as whisperx_transcribe

DOWNLOAD_TIMEOUT_SECONDS = 60.0 * 30  # long-form podcast episodes can take a while to fetch


class JobStore:
    """In-memory job table plus GPU-serialization backpressure.

    `max_queued` bounds how many jobs may be queued or processing at once
    (submitting past it returns 429 — CastRecall treats 429 as retryable).
    `max_active` bounds how many transcriptions actually run concurrently
    (a semaphore around the GPU work itself); a single CUDA device can only
    usefully serialize one WhisperX run at a time by default.
    """

    def __init__(self, max_active: int, max_queued: int):
        self.jobs: dict[str, dict[str, Any]] = {}
        self.max_queued = max_queued
        self.semaphore = asyncio.Semaphore(max_active)

    def active_count(self) -> int:
        return sum(1 for job in self.jobs.values() if job["status"] in ("queued", "processing"))


@asynccontextmanager
async def lifespan(app: FastAPI):
    settings = load_settings()
    app.state.settings = settings
    app.state.store = JobStore(settings.max_active_jobs, settings.max_queued_jobs)
    yield


app = FastAPI(lifespan=lifespan)


def get_settings(request: Request) -> Settings:
    return request.app.state.settings


def get_store(request: Request) -> JobStore:
    return request.app.state.store


@app.middleware("http")
async def require_token(request: Request, call_next):
    settings: Settings = request.app.state.settings
    expected = f"Bearer {settings.token}"
    provided = request.headers.get("authorization", "")
    # Constant-time comparison: a naive `==` leaks token length/prefix
    # timing information to an attacker probing the endpoint.
    if not hmac.compare_digest(provided, expected):
        return _json_error(401, "unauthorized: missing or incorrect bearer token")
    return await call_next(request)


def _json_error(status_code: int, detail: str):
    from fastapi.responses import JSONResponse

    return JSONResponse(status_code=status_code, content={"detail": detail})


def _coerce_bool(raw: Any, default: bool) -> bool:
    if raw is None or raw == "":
        return default
    if isinstance(raw, bool):
        return raw
    return str(raw).strip().lower() in ("1", "true", "yes", "on")


def _coerce_int(raw: Any, default: int) -> int:
    if raw is None or raw == "":
        return default
    return int(raw)


async def _parse_transcribe_request(request: Request) -> tuple[dict[str, Any], Optional[bytes], Optional[str]]:
    """Returns (fields, uploaded_bytes, uploaded_filename)."""
    content_type = request.headers.get("content-type", "")
    if content_type.startswith("multipart/form-data"):
        form = await request.form()
        upload = form.get("file")
        fields = {
            "audio_url": form.get("audio_url"),
            "model": form.get("model"),
            "language": form.get("language"),
            "batch_size": form.get("batch_size"),
            "compute_type": form.get("compute_type"),
            "timestamps": form.get("timestamps"),
            "diarize": form.get("diarize"),
        }
        if upload is not None and hasattr(upload, "read"):
            return fields, await upload.read(), getattr(upload, "filename", None)
        return fields, None, None
    body = await request.json() if await request.body() else {}
    return body, None, None


async def _submit_transcribe(request: Request) -> dict[str, str]:
    settings = get_settings(request)
    store = get_store(request)
    fields, audio_bytes, filename = await _parse_transcribe_request(request)
    audio_url = fields.get("audio_url") or None

    if not audio_url and audio_bytes is None:
        raise HTTPException(status_code=400, detail="audio_url or an uploaded file is required")

    if store.active_count() >= store.max_queued:
        raise HTTPException(status_code=429, detail="worker queue is full; try again later")

    opts = TranscribeOptions(
        model=fields.get("model") or settings.model,
        language=fields.get("language") or settings.language,
        batch_size=_coerce_int(fields.get("batch_size"), settings.batch_size),
        compute_type=fields.get("compute_type") or settings.compute_type,
        timestamps=_coerce_bool(fields.get("timestamps"), True),
        diarize=_coerce_bool(fields.get("diarize"), settings.diarize),
    )

    job_id = str(uuid.uuid4())
    store.jobs[job_id] = {"status": "queued", "result": None, "error": None}
    asyncio.create_task(
        _run_job(job_id, audio_url=audio_url, audio_bytes=audio_bytes, filename=filename, opts=opts, settings=settings, store=store)
    )
    return {"job_id": job_id, "status": "queued"}


async def _stage_audio(audio_url: Optional[str], audio_bytes: Optional[bytes], filename: Optional[str]) -> str:
    suffix = Path((filename or (audio_url or "")).split("?")[0]).suffix or ".mp3"
    fd, path = tempfile.mkstemp(prefix="whisperx-worker-", suffix=suffix)
    try:
        with open(fd, "wb") as f:
            if audio_bytes is not None:
                f.write(audio_bytes)
            else:
                async with httpx.AsyncClient(follow_redirects=True, timeout=DOWNLOAD_TIMEOUT_SECONDS) as client:
                    async with client.stream("GET", audio_url) as response:
                        response.raise_for_status()
                        async for chunk in response.aiter_bytes():
                            f.write(chunk)
        return path
    except Exception:
        Path(path).unlink(missing_ok=True)
        raise


async def _run_job(
    job_id: str,
    *,
    audio_url: Optional[str],
    audio_bytes: Optional[bytes],
    filename: Optional[str],
    opts: TranscribeOptions,
    settings: Settings,
    store: JobStore,
) -> None:
    store.jobs[job_id]["status"] = "processing"
    audio_path: Optional[str] = None
    try:
        audio_path = await _stage_audio(audio_url, audio_bytes, filename)
        async with store.semaphore:
            raw = await asyncio.to_thread(whisperx_transcribe, audio_path, opts, settings.hf_token)
        store.jobs[job_id]["status"] = "completed"
        store.jobs[job_id]["result"] = _normalize_result(raw)
    except Exception as exc:  # noqa: BLE001 - surfaced as the job's terminal error, not raised
        store.jobs[job_id]["status"] = "failed"
        store.jobs[job_id]["error"] = str(exc)
    finally:
        # Deleted on every exit path (success, backend exception, download
        # failure) unless the operator explicitly opts to keep it.
        if audio_path and settings.delete_audio:
            Path(audio_path).unlink(missing_ok=True)


def _normalize_result(raw: dict[str, Any]) -> dict[str, Any]:
    """Shapes the backend's raw dict into the remote-stt wire contract:
    `{ text?, segments?, model?, implementation?, warnings?, duration? }`
    with `segments[].start/end` in seconds — see `remote-stt.ts`'s
    `parseRemoteResult`. `text` is left unset; CastRecall synthesizes it
    from `segments` when absent, matching every other rung's convention.
    """
    segments = [
        {"speaker": seg.get("speaker"), "text": seg.get("text", ""), "start": seg.get("start"), "end": seg.get("end")}
        for seg in raw.get("segments", [])
    ]
    result: dict[str, Any] = {
        "segments": segments,
        "model": raw.get("model"),
        "implementation": raw.get("implementation", "whisperx"),
        "duration": raw.get("duration"),
    }
    if raw.get("warnings"):
        result["warnings"] = raw["warnings"]
    return result


@app.get("/health")
async def health(request: Request):
    settings = get_settings(request)
    return {"status": "ok", "implementation": "whisperx", "model": settings.model}


@app.post("/transcribe")
@app.post("/v1/transcriptions")
async def submit_transcribe(request: Request):
    return await _submit_transcribe(request)


@app.get("/jobs/{job_id}")
@app.get("/v1/jobs/{job_id}")
async def get_job(job_id: str, request: Request):
    store = get_store(request)
    job = store.jobs.get(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="unknown job id")
    body: dict[str, Any] = {"status": job["status"]}
    if job["status"] == "completed":
        body["result"] = job["result"]
    if job["status"] == "failed":
        body["error"] = job["error"]
    return body


@app.get("/v1/jobs/{job_id}/result")
async def get_job_result(job_id: str, request: Request):
    store = get_store(request)
    job = store.jobs.get(job_id)
    if job is None or job["status"] != "completed":
        raise HTTPException(status_code=404, detail="result not available (job unknown or not completed)")
    return job["result"]
