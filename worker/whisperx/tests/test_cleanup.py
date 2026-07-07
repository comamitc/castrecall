"""Temp-audio cleanup tests. Multipart submits stage the real file on disk
(no network involved), so these exercise the real `_stage_audio` path and
assert the resulting temp file is gone once the job finishes — on success,
on a backend exception, and (separately) on a download failure when the
audio comes from a URL instead of an upload.
"""

import pathlib
import tempfile

import app as app_module
from conftest import wait_for_status


def _spy_stage_audio(monkeypatch, captured: list):
    real_stage_audio = app_module._stage_audio

    async def spy(audio_url, staged_path, settings):
        path = await real_stage_audio(audio_url, staged_path, settings)
        captured.append(path)
        return path

    monkeypatch.setattr(app_module, "_stage_audio", spy)


def test_temp_file_removed_after_success(client, auth_headers, monkeypatch):
    captured: list = []
    _spy_stage_audio(monkeypatch, captured)
    monkeypatch.setattr(
        app_module,
        "whisperx_transcribe",
        lambda path, opts, hf_token: {
            "segments": [{"speaker": None, "text": "ok", "start": 0.0, "end": 1.0}],
            "model": "large-v3",
            "implementation": "whisperx",
            "duration": 1.0,
            "warnings": [],
        },
    )
    submitted = client.post(
        "/transcribe", headers=auth_headers, files={"file": ("episode.mp3", b"fake bytes", "audio/mpeg")}
    )
    job_id = submitted.json()["job_id"]
    wait_for_status(client, job_id, auth_headers, "completed")

    assert len(captured) == 1
    assert not pathlib.Path(captured[0]).exists()


def test_multipart_upload_streamed_to_disk_matches_uploaded_bytes(client, auth_headers, monkeypatch):
    """The upload is now streamed to a temp file in 1MB chunks (see
    `_stream_upload_to_tempfile`) instead of read fully into memory first.
    Uses a payload larger than one chunk to prove multi-chunk writes don't
    corrupt or truncate the staged file.
    """
    captured_content: list = []
    real_stage_audio = app_module._stage_audio

    async def spy(audio_url, staged_path, settings):
        path = await real_stage_audio(audio_url, staged_path, settings)
        captured_content.append(pathlib.Path(path).read_bytes())
        return path

    monkeypatch.setattr(app_module, "_stage_audio", spy)
    monkeypatch.setattr(
        app_module,
        "whisperx_transcribe",
        lambda path, opts, hf_token: {
            "segments": [],
            "model": "m",
            "implementation": "whisperx",
            "duration": 0,
            "warnings": [],
        },
    )

    payload = b"x" * (1024 * 1024 + 12345)  # spans more than one 1MB read chunk
    submitted = client.post(
        "/transcribe", headers=auth_headers, files={"file": ("episode.mp3", payload, "audio/mpeg")}
    )
    job_id = submitted.json()["job_id"]
    wait_for_status(client, job_id, auth_headers, "completed")

    assert captured_content == [payload]


def test_temp_file_removed_after_backend_exception(client, auth_headers, monkeypatch):
    captured: list = []
    _spy_stage_audio(monkeypatch, captured)

    def failing_backend(path, opts, hf_token):
        raise RuntimeError("backend blew up")

    monkeypatch.setattr(app_module, "whisperx_transcribe", failing_backend)
    submitted = client.post(
        "/transcribe", headers=auth_headers, files={"file": ("episode.mp3", b"fake bytes", "audio/mpeg")}
    )
    job_id = submitted.json()["job_id"]
    wait_for_status(client, job_id, auth_headers, "failed")

    assert len(captured) == 1
    assert not pathlib.Path(captured[0]).exists()


def test_temp_file_kept_when_delete_audio_false(monkeypatch):
    from fastapi.testclient import TestClient

    monkeypatch.setenv("WORKER_TOKEN", "keep-token")
    monkeypatch.setenv("DELETE_AUDIO", "false")
    headers = {"authorization": "Bearer keep-token"}
    captured: list = []

    with TestClient(app_module.app) as keep_client:
        _spy_stage_audio(monkeypatch, captured)
        monkeypatch.setattr(
            app_module,
            "whisperx_transcribe",
            lambda path, opts, hf_token: {
                "segments": [{"speaker": None, "text": "ok", "start": 0.0, "end": 1.0}],
                "model": "large-v3",
                "implementation": "whisperx",
                "duration": 1.0,
                "warnings": [],
            },
        )
        submitted = keep_client.post(
            "/transcribe", headers=headers, files={"file": ("episode.mp3", b"fake bytes", "audio/mpeg")}
        )
        job_id = submitted.json()["job_id"]
        wait_for_status(keep_client, job_id, headers, "completed")

        assert len(captured) == 1
        kept_path = pathlib.Path(captured[0])
        try:
            assert kept_path.exists()
        finally:
            kept_path.unlink(missing_ok=True)


def test_multipart_upload_rejected_by_backpressure_leaves_no_temp_file(monkeypatch):
    """The queue-full check reserves capacity before the request body is
    read at all, so a full queue must reject a multipart upload without
    ever staging it to disk in the first place.
    """
    from fastapi.testclient import TestClient

    monkeypatch.setenv("WORKER_TOKEN", "full-queue-token")
    monkeypatch.setenv("MAX_QUEUED_JOBS", "0")
    headers = {"authorization": "Bearer full-queue-token"}

    tmp_dir = pathlib.Path(tempfile.gettempdir())
    before = {p.name for p in tmp_dir.glob("whisperx-worker-*")}

    with TestClient(app_module.app) as full_client:
        response = full_client.post(
            "/transcribe", headers=headers, files={"file": ("episode.mp3", b"fake bytes", "audio/mpeg")}
        )
        assert response.status_code == 429

    after = {p.name for p in tmp_dir.glob("whisperx-worker-*")}
    assert after == before


def test_download_failure_marks_job_failed_and_leaves_no_temp_file(client, auth_headers, monkeypatch):
    class _FailingResponse:
        status_code = 503
        headers: dict = {}

        def raise_for_status(self):
            raise RuntimeError("download failed with status 503")

        async def aiter_bytes(self):
            if False:  # pragma: no cover - never reached, raise_for_status raises first
                yield b""

    class _FailingStreamCtx:
        async def __aenter__(self):
            return _FailingResponse()

        async def __aexit__(self, exc_type, exc, tb):
            return False

    class _FailingAsyncClient:
        def __init__(self, *args, **kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, exc_type, exc, tb):
            return False

        def stream(self, method, url):
            return _FailingStreamCtx()

    tmp_dir = pathlib.Path(tempfile.gettempdir())
    before = {p.name for p in tmp_dir.glob("whisperx-worker-*")}
    monkeypatch.setattr(app_module, "_resolve_host", lambda host: ["93.184.216.34"])
    monkeypatch.setattr(app_module.httpx, "AsyncClient", _FailingAsyncClient)

    submitted = client.post("/transcribe", headers=auth_headers, json={"audio_url": "https://example.com/gone.mp3"})
    job_id = submitted.json()["job_id"]
    body = wait_for_status(client, job_id, auth_headers, "failed")
    assert "503" in body["error"]

    after = {p.name for p in tmp_dir.glob("whisperx-worker-*")}
    assert after == before
