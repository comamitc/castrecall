"""HTTP-contract tests for the worker (issue #62), backend mocked — no GPU,
no WhisperX/torch, no network required. Audio staging is bypassed by
monkeypatching `app._stage_audio` so these tests exercise auth, routing,
job lifecycle, option-forwarding, and backpressure in isolation from the
filesystem/network staging path (covered separately in test_cleanup.py).
"""

import threading

import app as app_module
from conftest import wait_for_status


async def _fake_stage_audio(audio_url, audio_bytes, filename):
    return "/tmp/fake-staged-audio.mp3"


def _patch_stage_audio(monkeypatch):
    monkeypatch.setattr(app_module, "_stage_audio", _fake_stage_audio)


def _fake_backend(result=None):
    result = result or {
        "segments": [{"speaker": None, "text": "hello world", "start": 0.0, "end": 1.0}],
        "model": "large-v3",
        "implementation": "whisperx",
        "duration": 1.0,
        "warnings": [],
    }

    def fake_transcribe(path, opts, hf_token):
        return result

    return fake_transcribe


# --- Auth -------------------------------------------------------------------


def test_health_requires_token(client):
    assert client.get("/health").status_code == 401


def test_health_with_correct_token(client, auth_headers):
    response = client.get("/health", headers=auth_headers)
    assert response.status_code == 200
    body = response.json()
    assert body["implementation"] == "whisperx"
    assert "model" in body


def test_health_with_wrong_token_is_401_and_leaks_nothing(client):
    response = client.get("/health", headers={"authorization": "Bearer wrong-token"})
    assert response.status_code == 401
    assert "result" not in response.text


def test_transcribe_requires_token(client):
    response = client.post("/transcribe", json={"audio_url": "https://example.com/a.mp3"})
    assert response.status_code == 401
    assert "result" not in response.text


def test_jobs_poll_requires_token(client):
    response = client.get("/jobs/some-id")
    assert response.status_code == 401


def test_v1_result_requires_token(client):
    response = client.get("/v1/jobs/some-id/result")
    assert response.status_code == 401
    assert "result" not in response.text


# --- Submit shapes ------------------------------------------------------------


def test_submit_json_returns_queued(client, auth_headers, monkeypatch):
    _patch_stage_audio(monkeypatch)
    monkeypatch.setattr(app_module, "whisperx_transcribe", _fake_backend())
    response = client.post("/transcribe", headers=auth_headers, json={"audio_url": "https://example.com/a.mp3"})
    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "queued"
    assert body["job_id"]


def test_submit_v1_alias_returns_same_shape(client, auth_headers, monkeypatch):
    _patch_stage_audio(monkeypatch)
    monkeypatch.setattr(app_module, "whisperx_transcribe", _fake_backend())
    response = client.post(
        "/v1/transcriptions", headers=auth_headers, json={"audio_url": "https://example.com/a.mp3"}
    )
    assert response.status_code == 200
    assert response.json()["status"] == "queued"


def test_submit_multipart_file(client, auth_headers, monkeypatch):
    _patch_stage_audio(monkeypatch)
    monkeypatch.setattr(app_module, "whisperx_transcribe", _fake_backend())
    response = client.post(
        "/transcribe", headers=auth_headers, files={"file": ("episode.mp3", b"fake bytes", "audio/mpeg")}
    )
    assert response.status_code == 200
    assert response.json()["status"] == "queued"


def test_submit_without_audio_url_or_file_is_400(client, auth_headers):
    response = client.post("/transcribe", headers=auth_headers, json={})
    assert response.status_code == 400


# --- Lifecycle + normalized result -------------------------------------------


def test_lifecycle_reaches_completed_with_normalized_result(client, auth_headers, monkeypatch):
    _patch_stage_audio(monkeypatch)
    monkeypatch.setattr(app_module, "whisperx_transcribe", _fake_backend())
    submitted = client.post("/transcribe", headers=auth_headers, json={"audio_url": "https://example.com/a.mp3"})
    job_id = submitted.json()["job_id"]
    body = wait_for_status(client, job_id, auth_headers, "completed")
    result = body["result"]
    assert result["implementation"] == "whisperx"
    assert result["model"] == "large-v3"
    assert result["duration"] == 1.0
    assert result["segments"][0]["text"] == "hello world"
    assert result["segments"][0]["start"] == 0.0
    assert result["segments"][0]["end"] == 1.0


def test_v1_job_alias_matches_canonical(client, auth_headers, monkeypatch):
    _patch_stage_audio(monkeypatch)
    monkeypatch.setattr(app_module, "whisperx_transcribe", _fake_backend())
    submitted = client.post("/transcribe", headers=auth_headers, json={"audio_url": "https://example.com/a.mp3"})
    job_id = submitted.json()["job_id"]
    wait_for_status(client, job_id, auth_headers, "completed")
    canonical = client.get(f"/jobs/{job_id}", headers=auth_headers).json()
    aliased = client.get(f"/v1/jobs/{job_id}", headers=auth_headers).json()
    assert canonical == aliased


def test_v1_result_endpoint_404_before_completion_then_bare_result(client, auth_headers, monkeypatch):
    started = threading.Event()
    release = threading.Event()

    def slow_backend(path, opts, hf_token):
        started.set()
        release.wait(timeout=5)
        return {
            "segments": [{"speaker": None, "text": "slow", "start": 0.0, "end": 1.0}],
            "model": "large-v3",
            "implementation": "whisperx",
            "duration": 1.0,
            "warnings": [],
        }

    _patch_stage_audio(monkeypatch)
    monkeypatch.setattr(app_module, "whisperx_transcribe", slow_backend)
    submitted = client.post("/transcribe", headers=auth_headers, json={"audio_url": "https://example.com/a.mp3"})
    job_id = submitted.json()["job_id"]
    started.wait(timeout=5)

    not_ready = client.get(f"/v1/jobs/{job_id}/result", headers=auth_headers)
    assert not_ready.status_code == 404

    release.set()
    wait_for_status(client, job_id, auth_headers, "completed")
    ready = client.get(f"/v1/jobs/{job_id}/result", headers=auth_headers)
    assert ready.status_code == 200
    assert ready.json()["segments"][0]["text"] == "slow"


def test_unknown_job_id_is_404(client, auth_headers):
    assert client.get("/jobs/does-not-exist", headers=auth_headers).status_code == 404
    assert client.get("/v1/jobs/does-not-exist/result", headers=auth_headers).status_code == 404


# --- Options forwarding -------------------------------------------------------


def test_all_six_options_reach_the_backend_via_json(client, auth_headers, monkeypatch):
    captured = {}

    def capturing_backend(path, opts, hf_token):
        captured["opts"] = opts
        return {"segments": [{"speaker": None, "text": "ok", "start": 0.0, "end": 1.0}], "model": opts.model,
                "implementation": "whisperx", "duration": 1.0, "warnings": []}

    _patch_stage_audio(monkeypatch)
    monkeypatch.setattr(app_module, "whisperx_transcribe", capturing_backend)
    submitted = client.post(
        "/transcribe",
        headers=auth_headers,
        json={
            "audio_url": "https://example.com/a.mp3",
            "model": "medium",
            "language": "fr",
            "batch_size": 4,
            "compute_type": "int8",
            "timestamps": False,
            "diarize": True,
        },
    )
    job_id = submitted.json()["job_id"]
    wait_for_status(client, job_id, auth_headers, "completed")

    opts = captured["opts"]
    assert opts.model == "medium"
    assert opts.language == "fr"
    assert opts.batch_size == 4
    assert opts.compute_type == "int8"
    assert opts.timestamps is False
    assert opts.diarize is True


def test_all_six_options_reach_the_backend_via_multipart(client, auth_headers, monkeypatch):
    captured = {}

    def capturing_backend(path, opts, hf_token):
        captured["opts"] = opts
        return {"segments": [{"speaker": None, "text": "ok", "start": 0.0, "end": 1.0}], "model": opts.model,
                "implementation": "whisperx", "duration": 1.0, "warnings": []}

    _patch_stage_audio(monkeypatch)
    monkeypatch.setattr(app_module, "whisperx_transcribe", capturing_backend)
    submitted = client.post(
        "/transcribe",
        headers=auth_headers,
        files={"file": ("episode.mp3", b"fake bytes", "audio/mpeg")},
        data={
            "model": "medium",
            "language": "fr",
            "batch_size": "4",
            "compute_type": "int8",
            "timestamps": "false",
            "diarize": "true",
        },
    )
    job_id = submitted.json()["job_id"]
    wait_for_status(client, job_id, auth_headers, "completed")

    opts = captured["opts"]
    assert opts.model == "medium"
    assert opts.language == "fr"
    assert opts.batch_size == 4
    assert opts.compute_type == "int8"
    assert opts.timestamps is False
    assert opts.diarize is True


def test_options_default_from_settings_when_omitted(client, auth_headers, monkeypatch):
    captured = {}

    def capturing_backend(path, opts, hf_token):
        captured["opts"] = opts
        return {"segments": [{"speaker": None, "text": "ok", "start": 0.0, "end": 1.0}], "model": opts.model,
                "implementation": "whisperx", "duration": 1.0, "warnings": []}

    _patch_stage_audio(monkeypatch)
    monkeypatch.setattr(app_module, "whisperx_transcribe", capturing_backend)
    submitted = client.post("/transcribe", headers=auth_headers, json={"audio_url": "https://example.com/a.mp3"})
    job_id = submitted.json()["job_id"]
    wait_for_status(client, job_id, auth_headers, "completed")

    opts = captured["opts"]
    assert opts.model == "large-v3"
    assert opts.batch_size == 16
    assert opts.compute_type == "float16"
    assert opts.timestamps is True
    assert opts.diarize is False


# --- Failure handling ---------------------------------------------------------


def test_backend_exception_marks_job_failed(client, auth_headers, monkeypatch):
    def failing_backend(path, opts, hf_token):
        raise RuntimeError("GPU OOM")

    _patch_stage_audio(monkeypatch)
    monkeypatch.setattr(app_module, "whisperx_transcribe", failing_backend)
    submitted = client.post("/transcribe", headers=auth_headers, json={"audio_url": "https://example.com/a.mp3"})
    job_id = submitted.json()["job_id"]
    body = wait_for_status(client, job_id, auth_headers, "failed")
    assert "GPU OOM" in body["error"]

    not_ready = client.get(f"/v1/jobs/{job_id}/result", headers=auth_headers)
    assert not_ready.status_code == 404


# --- Backpressure --------------------------------------------------------------


def test_backpressure_returns_429_past_max_queued_jobs(monkeypatch):
    from fastapi.testclient import TestClient

    monkeypatch.setenv("WORKER_TOKEN", "backpressure-token")
    monkeypatch.setenv("MAX_QUEUED_JOBS", "1")
    monkeypatch.setenv("MAX_ACTIVE_JOBS", "1")
    headers = {"authorization": "Bearer backpressure-token"}

    started = threading.Event()
    release = threading.Event()

    def blocking_backend(path, opts, hf_token):
        started.set()
        release.wait(timeout=5)
        return {"segments": [], "model": "m", "implementation": "whisperx", "duration": 0, "warnings": []}

    with TestClient(app_module.app) as blocked_client:
        monkeypatch.setattr(app_module, "_stage_audio", _fake_stage_audio)
        monkeypatch.setattr(app_module, "whisperx_transcribe", blocking_backend)

        first = blocked_client.post("/transcribe", headers=headers, json={"audio_url": "https://example.com/a.mp3"})
        assert first.status_code == 200
        started.wait(timeout=5)

        second = blocked_client.post("/transcribe", headers=headers, json={"audio_url": "https://example.com/b.mp3"})
        assert second.status_code == 429

        release.set()
