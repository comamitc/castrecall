"""Reference WhisperX remote STT worker (issue #62).

Implements the generic remote STT contract CastRecall's `remote-stt`
provider actually speaks (`src/transcripts/remote-stt.ts`, mirrored in the
root README's "Remote STT contract"):

    GET  {base}/health              -> readiness probe: 200 once CUDA/model load, else 503
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
import ipaddress
import socket
import tempfile
import uuid
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any, Optional
from urllib.parse import urljoin, urlparse

import httpx
from fastapi import FastAPI, HTTPException, Request

from config import Settings, load_settings
from whisperx_backend import TranscribeOptions
from whisperx_backend import check_readiness as whisperx_check_readiness
from whisperx_backend import transcribe as whisperx_transcribe

DOWNLOAD_TIMEOUT_SECONDS = 60.0 * 30  # long-form podcast episodes can take a while to fetch
MAX_AUDIO_URL_REDIRECTS = 5
# Multipart boundaries/headers around the file part; generous but bounded.
MULTIPART_OVERHEAD_BYTES = 1024 * 1024


class AudioTooLargeError(Exception):
    """Raised when staged/downloaded audio exceeds `Settings.max_audio_bytes`."""


class AudioUrlBlockedError(Exception):
    """Raised when an `audio_url` (or a redirect target) is disallowed —
    wrong scheme, or resolves to a loopback/private/link-local/multicast
    address on the worker's own network (see `_validate_audio_url`).
    """


class JobStore:
    """In-memory job table plus GPU-serialization backpressure.

    `max_queued` bounds how many jobs may be queued or processing at once
    (submitting past it returns 429 — CastRecall treats 429 as retryable).
    `max_active` bounds how many transcriptions actually run concurrently
    (a semaphore around the GPU work itself); a single CUDA device can only
    usefully serialize one WhisperX run at a time by default. `max_completed_jobs`
    bounds how many terminal (completed/failed) jobs are kept in memory at
    once, so a long-running worker doesn't accumulate every past transcript
    forever (see `mark_terminal`).
    """

    def __init__(self, max_active: int, max_queued: int, max_completed_jobs: int):
        self.jobs: dict[str, dict[str, Any]] = {}
        self.max_queued = max_queued
        self.max_completed_jobs = max_completed_jobs
        self.semaphore = asyncio.Semaphore(max_active)
        self._reserved = 0
        self._terminal_order: list[str] = []

    def active_count(self) -> int:
        return sum(1 for job in self.jobs.values() if job["status"] in ("queued", "processing"))

    def try_reserve(self) -> bool:
        """Atomically reserves a queue slot before the request body is read,
        so a full queue rejects a submission before any bytes are staged to
        disk. Safe against concurrent submissions because nothing here
        awaits between the check and the increment.
        """
        if self.active_count() + self._reserved >= self.max_queued:
            return False
        self._reserved += 1
        return True

    def release_reservation(self) -> None:
        self._reserved -= 1

    def commit_reservation(self, job_id: str, entry: dict[str, Any]) -> None:
        self._reserved -= 1
        self.jobs[job_id] = entry

    def mark_terminal(self, job_id: str) -> None:
        """Evicts the oldest terminal jobs once more than `max_completed_jobs`
        are retained, so completed/failed transcripts don't accumulate in
        memory indefinitely on a long-running worker.
        """
        self._terminal_order.append(job_id)
        while len(self._terminal_order) > self.max_completed_jobs:
            oldest = self._terminal_order.pop(0)
            self.jobs.pop(oldest, None)


@asynccontextmanager
async def lifespan(app: FastAPI):
    settings = load_settings()
    app.state.settings = settings
    app.state.store = JobStore(settings.max_active_jobs, settings.max_queued_jobs, settings.max_completed_jobs)
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


async def _parse_transcribe_request(
    request: Request, settings: Settings
) -> tuple[dict[str, Any], Optional[str], Optional[str]]:
    """Returns (fields, staged_path, uploaded_filename).

    Multipart uploads are streamed straight to a temp file in chunks here
    rather than read fully into memory as `bytes` — podcast episodes can be
    hundreds of MB, and buffering a whole episode in RAM while its job sits
    in the queue defeats the queue's own backpressure.
    """
    content_type = request.headers.get("content-type", "")
    if content_type.startswith("multipart/form-data"):
        # Enforce the size bound BEFORE Starlette parses the multipart body:
        # request.form() spools the whole upload to disk first, so a
        # post-parse check would let an oversized request consume temp
        # storage before the 413. Content-Length is required (the server
        # rejects bodies that exceed the declared length at the protocol
        # level), with slack for multipart framing overhead.
        declared = request.headers.get("content-length")
        if declared is None:
            raise HTTPException(
                status_code=411, detail="Content-Length is required for multipart uploads"
            )
        try:
            declared_bytes = int(declared)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail="invalid Content-Length") from exc
        if declared_bytes > settings.max_audio_bytes + MULTIPART_OVERHEAD_BYTES:
            raise AudioTooLargeError(
                f"multipart request declares {declared_bytes} bytes, exceeding the "
                f"{settings.max_audio_bytes}-byte limit (MAX_AUDIO_BYTES)"
            )
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
            filename = getattr(upload, "filename", None)
            path = await _stream_upload_to_tempfile(upload, filename, settings.max_audio_bytes)
            return fields, path, filename
        return fields, None, None
    body = await request.json() if await request.body() else {}
    return body, None, None


async def _stream_upload_to_tempfile(upload: Any, filename: Optional[str], max_bytes: int) -> str:
    suffix = Path(filename or "").suffix or ".mp3"
    fd, path = tempfile.mkstemp(prefix="whisperx-worker-", suffix=suffix)
    total = 0
    try:
        with open(fd, "wb") as f:
            while chunk := await upload.read(1024 * 1024):
                total += len(chunk)
                if total > max_bytes:
                    raise AudioTooLargeError(
                        f"uploaded audio exceeds the {max_bytes}-byte limit (MAX_AUDIO_BYTES)"
                    )
                f.write(chunk)
        return path
    except Exception:
        Path(path).unlink(missing_ok=True)
        raise


async def _submit_transcribe(request: Request) -> dict[str, str]:
    settings = get_settings(request)
    store = get_store(request)

    # Reserve queue capacity before reading the request body at all: a full
    # queue must reject the submission before staging any audio to disk,
    # not after (see AudioTooLargeError finding — a full queue was still
    # accepting and writing a whole upload before returning 429).
    if not store.try_reserve():
        raise HTTPException(status_code=429, detail="worker queue is full; try again later")

    staged_path: Optional[str] = None
    try:
        fields, staged_path, filename = await _parse_transcribe_request(request, settings)
        audio_url = fields.get("audio_url") or None

        if not audio_url and staged_path is None:
            raise HTTPException(status_code=400, detail="audio_url or an uploaded file is required")

        opts = TranscribeOptions(
            model=fields.get("model") or settings.model,
            language=fields.get("language") or settings.language,
            batch_size=_coerce_int(fields.get("batch_size"), settings.batch_size),
            compute_type=fields.get("compute_type") or settings.compute_type,
            timestamps=_coerce_bool(fields.get("timestamps"), True),
            diarize=_coerce_bool(fields.get("diarize"), settings.diarize),
        )

        job_id = str(uuid.uuid4())
        store.commit_reservation(job_id, {"status": "queued", "result": None, "error": None})
    except AudioTooLargeError as exc:
        store.release_reservation()
        if staged_path:
            Path(staged_path).unlink(missing_ok=True)
        raise HTTPException(status_code=413, detail=str(exc)) from exc
    except Exception:
        store.release_reservation()
        if staged_path:
            Path(staged_path).unlink(missing_ok=True)
        raise

    asyncio.create_task(
        _run_job(job_id, audio_url=audio_url, staged_path=staged_path, opts=opts, settings=settings, store=store)
    )
    return {"job_id": job_id, "status": "queued"}


def _resolve_host(host: str) -> list[str]:
    """Thin wrapper around `socket.getaddrinfo` so tests can substitute
    resolved addresses without real DNS/network access.
    """
    return [info[4][0] for info in socket.getaddrinfo(host, None)]


def _validate_audio_url_sync(url: str) -> list[str]:
    """Validates the URL and returns the single vetted address the caller
    must PIN its connection to. Denies every non-global destination
    (`ipaddress`'s `is_global` is False for private, loopback, link-local,
    multicast, reserved, unspecified AND shared/CGNAT 100.64.0.0/10 space —
    the range Tailscale uses — which the old allowlist-of-flags missed).
    """
    parsed = urlparse(url)
    if parsed.scheme not in ("http", "https"):
        raise AudioUrlBlockedError(f"audio_url scheme {parsed.scheme!r} is not allowed; use http or https")
    host = parsed.hostname
    if not host:
        raise AudioUrlBlockedError("audio_url has no hostname")
    try:
        addresses = _resolve_host(host)
    except OSError as exc:
        raise AudioUrlBlockedError(f"could not resolve audio_url host {host!r}: {exc}") from exc
    if not addresses:
        raise AudioUrlBlockedError(f"audio_url host {host!r} resolved to no addresses")
    for address in addresses:
        ip = ipaddress.ip_address(address)
        # is_multicast is checked explicitly: some multicast ranges (GLOP,
        # 224.0.1.0/24 …) are "globally routable" and pass is_global, but a
        # multicast destination is never a legitimate audio host.
        if ip.is_multicast or not ip.is_global:
            raise AudioUrlBlockedError(f"audio_url host {host!r} resolves to disallowed address {ip}")
    return list(dict.fromkeys(addresses))


async def _validate_audio_url(url: str, settings: Settings) -> Optional[list[str]]:
    """Blocks fetches to any non-public address so a malicious or
    compromised podcast feed can't use this worker's own network access to
    reach internal services (metadata endpoints, Tailscale-only hosts,
    etc). Returns the vetted address the caller must connect to — the
    download is PINNED to it, so a DNS answer that changes between
    validation and connect (DNS rebinding) can never redirect the fetch to
    a different address than the one checked. `ALLOW_PRIVATE_AUDIO_URLS`
    opts an operator out (no pinning) for deployments that deliberately
    host audio internally.
    """
    if settings.allow_private_audio_urls:
        return None
    return await asyncio.to_thread(_validate_audio_url_sync, url)


def _pinned_request(url: str, pinned_address: str) -> tuple[str, dict[str, str], dict[str, Any]]:
    """Rewrites `url` to connect to `pinned_address` while preserving the
    original hostname for the Host header and TLS SNI/verification — the
    connection can only reach the address that was actually validated.
    """
    parsed = urlparse(url)
    host = parsed.hostname or ""
    ip_host = f"[{pinned_address}]" if ":" in pinned_address else pinned_address
    netloc = ip_host if parsed.port is None else f"{ip_host}:{parsed.port}"
    pinned_url = parsed._replace(netloc=netloc).geturl()
    host_header = host if parsed.port is None else f"{host}:{parsed.port}"
    headers = {"host": host_header}
    extensions: dict[str, Any] = {}
    if parsed.scheme == "https":
        # httpcore uses sni_hostname for both SNI and certificate
        # verification, so the cert is still checked against the real name.
        extensions["sni_hostname"] = host
    return pinned_url, headers, extensions


async def _stage_audio(audio_url: Optional[str], staged_path: Optional[str], settings: Settings) -> str:
    """Returns the local path to transcribe. An already-staged upload is
    returned as-is; an `audio_url` is downloaded here instead — called only
    once `store.semaphore` is held (see `_run_job`), so at most
    `MAX_ACTIVE_JOBS` downloads ever run concurrently instead of up to
    `MAX_QUEUED_JOBS`.

    Every hop (the initial URL and each redirect target) is re-validated by
    `_validate_audio_url` and the download is capped at
    `settings.max_audio_bytes`, aborting the stream as soon as it's crossed
    — redirects aren't followed automatically by httpx here specifically so
    a redirect to a disallowed address can't bypass the check.
    """
    if staged_path is not None:
        return staged_path
    suffix = Path(audio_url.split("?")[0]).suffix or ".mp3"
    fd, path = tempfile.mkstemp(prefix="whisperx-worker-", suffix=suffix)
    try:
        with open(fd, "wb") as f:
            async with httpx.AsyncClient(follow_redirects=False, timeout=DOWNLOAD_TIMEOUT_SECONDS) as client:
                current_url = audio_url
                for _ in range(MAX_AUDIO_URL_REDIRECTS + 1):
                    validated = await _validate_audio_url(current_url, settings)
                    candidates: list[Optional[str]] = list(validated) if validated else [None]
                    redirect_to: Optional[str] = None
                    for index, address in enumerate(candidates):
                        if address is not None:
                            request_url, pin_headers, pin_extensions = _pinned_request(current_url, address)
                        else:
                            request_url, pin_headers, pin_extensions = current_url, {}, {}
                        # Each attempt owns the staging file from byte 0: a
                        # previous candidate may have written partial bytes
                        # before failing mid-stream, and appending after them
                        # would hand the backend corrupted audio.
                        f.seek(0)
                        f.truncate()
                        try:
                            async with client.stream(
                                "GET", request_url, headers=pin_headers, extensions=pin_extensions
                            ) as response:
                                if response.status_code in (301, 302, 303, 307, 308):
                                    location = response.headers.get("location")
                                    if not location:
                                        raise AudioUrlBlockedError("redirect response missing Location header")
                                    redirect_to = urljoin(current_url, location)
                                    break
                                response.raise_for_status()
                                max_bytes = settings.max_audio_bytes
                                content_length = response.headers.get("content-length")
                                if content_length is not None:
                                    try:
                                        if int(content_length) > max_bytes:
                                            raise AudioTooLargeError(
                                                f"audio_url reports {content_length} bytes, exceeding the "
                                                f"{max_bytes}-byte limit (MAX_AUDIO_BYTES)"
                                            )
                                    except ValueError:
                                        pass
                                total = 0
                                async for chunk in response.aiter_bytes():
                                    total += len(chunk)
                                    if total > max_bytes:
                                        raise AudioTooLargeError(
                                            f"audio_url download exceeds the {max_bytes}-byte limit (MAX_AUDIO_BYTES)"
                                        )
                                    f.write(chunk)
                                return path
                        except httpx.TransportError:
                            # Connection-level failure on THIS validated
                            # address: try the next one. Only transport
                            # errors fall through — HTTP responses are
                            # authoritative for the host, not the address.
                            if index == len(candidates) - 1:
                                raise
                            continue
                    if redirect_to is not None:
                        current_url = redirect_to
                        continue
                raise AudioUrlBlockedError("audio_url redirected too many times")
    except Exception:
        Path(path).unlink(missing_ok=True)
        raise


async def _run_job(
    job_id: str,
    *,
    audio_url: Optional[str],
    staged_path: Optional[str],
    opts: TranscribeOptions,
    settings: Settings,
    store: JobStore,
) -> None:
    store.jobs[job_id]["status"] = "processing"
    audio_path: Optional[str] = None
    try:
        async with store.semaphore:
            audio_path = await _stage_audio(audio_url, staged_path, settings)
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
        store.mark_terminal(job_id)


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
    ready, reason = await asyncio.to_thread(whisperx_check_readiness, settings.model, settings.compute_type)
    if not ready:
        return _json_error(503, f"not ready: {reason}")
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
