"""Outbound-network safety and resource-bound tests (issue #62 review round
2): `audio_url` SSRF protection, staged-audio size ceilings, and bounded
terminal-job retention.

DNS resolution is monkeypatched via `app._resolve_host` -- the injectable
seam `_stage_audio`/`_validate_audio_url` call instead of `socket.getaddrinfo`
directly -- so these tests never touch real DNS/network and stay
deterministic offline. A test with no fake DNS entry configured proves the
check still fires (it raises rather than silently falling through) when the
injected fake is absent.
"""

import pathlib
import tempfile

import app as app_module
from conftest import wait_for_status


def _patch_resolve_host(monkeypatch, mapping):
    def fake_resolve_host(host):
        if host not in mapping:
            raise OSError(f"no fake DNS entry for {host!r}")
        return mapping[host]

    monkeypatch.setattr(app_module, "_resolve_host", fake_resolve_host)


def _fake_backend():
    return lambda path, opts, hf_token: {
        "segments": [],
        "model": "m",
        "implementation": "whisperx",
        "duration": 0,
        "warnings": [],
    }


# --- SSRF protection ---------------------------------------------------------


def test_audio_url_loopback_literal_is_blocked_without_dns(client, auth_headers):
    """A loopback IP literal needs no DNS resolution at all -- proves the
    disallowed-address check runs even with no fake DNS entry configured
    (i.e. it fails closed, not open, when nothing is mocked).
    """
    submitted = client.post("/transcribe", headers=auth_headers, json={"audio_url": "http://127.0.0.1:9999/secret"})
    job_id = submitted.json()["job_id"]
    body = wait_for_status(client, job_id, auth_headers, "failed")
    assert "disallowed address" in body["error"]


def test_audio_url_resolving_to_private_address_is_blocked(client, auth_headers, monkeypatch):
    """A hostname that looks public but resolves to an internal address
    (the DNS-rebinding-style attack the finding calls out) must still be
    blocked.
    """
    _patch_resolve_host(monkeypatch, {"sneaky.example": ["10.0.0.5"]})
    submitted = client.post(
        "/transcribe", headers=auth_headers, json={"audio_url": "http://sneaky.example/episode.mp3"}
    )
    job_id = submitted.json()["job_id"]
    body = wait_for_status(client, job_id, auth_headers, "failed")
    assert "disallowed address" in body["error"]


def test_audio_url_non_http_scheme_is_blocked(client, auth_headers):
    submitted = client.post("/transcribe", headers=auth_headers, json={"audio_url": "file:///etc/passwd"})
    job_id = submitted.json()["job_id"]
    body = wait_for_status(client, job_id, auth_headers, "failed")
    assert "scheme" in body["error"]


def test_audio_url_redirect_to_private_address_is_blocked(client, auth_headers, monkeypatch):
    """A public-looking first hop that redirects to an internal address must
    still be blocked -- redirects are followed manually in `_stage_audio`
    specifically so every hop is re-validated instead of trusting httpx's
    automatic redirect handling.
    """
    _patch_resolve_host(monkeypatch, {"public.example": ["93.184.216.34"], "127.0.0.1": ["127.0.0.1"]})

    class _RedirectResponse:
        status_code = 302
        headers = {"location": "http://127.0.0.1:9999/internal.mp3"}

        def raise_for_status(self):
            return None

        async def aiter_bytes(self):
            if False:  # pragma: no cover - never reached, it's a redirect
                yield b""

    class _RedirectStreamCtx:
        async def __aenter__(self):
            return _RedirectResponse()

        async def __aexit__(self, exc_type, exc, tb):
            return False

    class _RedirectAsyncClient:
        def __init__(self, *args, **kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, exc_type, exc, tb):
            return False

        def stream(self, method, url, **kwargs):
            return _RedirectStreamCtx()

    monkeypatch.setattr(app_module.httpx, "AsyncClient", _RedirectAsyncClient)
    submitted = client.post(
        "/transcribe", headers=auth_headers, json={"audio_url": "http://public.example/episode.mp3"}
    )
    job_id = submitted.json()["job_id"]
    body = wait_for_status(client, job_id, auth_headers, "failed")
    assert "disallowed address" in body["error"]


def test_allow_private_audio_urls_opt_out_permits_loopback(monkeypatch):
    """`ALLOW_PRIVATE_AUDIO_URLS=true` is an explicit operator opt-out for a
    deployment that deliberately hosts audio internally.
    """
    from fastapi.testclient import TestClient

    monkeypatch.setenv("WORKER_TOKEN", "private-ok-token")
    monkeypatch.setenv("ALLOW_PRIVATE_AUDIO_URLS", "true")
    headers = {"authorization": "Bearer private-ok-token"}

    class _OkResponse:
        status_code = 200
        headers: dict = {}

        def raise_for_status(self):
            return None

        async def aiter_bytes(self):
            yield b"fake-audio-bytes"

    class _OkStreamCtx:
        async def __aenter__(self):
            return _OkResponse()

        async def __aexit__(self, exc_type, exc, tb):
            return False

    class _OkAsyncClient:
        def __init__(self, *args, **kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, exc_type, exc, tb):
            return False

        def stream(self, method, url, **kwargs):
            return _OkStreamCtx()

    with TestClient(app_module.app) as private_client:
        monkeypatch.setattr(app_module.httpx, "AsyncClient", _OkAsyncClient)
        monkeypatch.setattr(app_module, "whisperx_transcribe", _fake_backend())
        submitted = private_client.post(
            "/transcribe", headers=headers, json={"audio_url": "http://127.0.0.1:9999/internal.mp3"}
        )
        job_id = submitted.json()["job_id"]
        wait_for_status(private_client, job_id, headers, "completed")


def test_audio_url_resolving_to_cgnat_shared_space_is_blocked(client, auth_headers, monkeypatch):
    """100.64.0.0/10 (shared address space, used by Tailscale) is not
    `is_private`, so a flag-allowlist check let it through -- the deny rule
    is now `not is_global`, which covers every non-public range."""
    _patch_resolve_host(monkeypatch, {"tailnet.example": ["100.101.102.103"]})
    submitted = client.post(
        "/transcribe", headers=auth_headers, json={"audio_url": "http://tailnet.example/ep.mp3"}
    )
    job_id = submitted.json()["job_id"]
    body = wait_for_status(client, job_id, auth_headers, "failed")
    assert "disallowed address" in body["error"]


def test_download_connects_to_the_validated_address_not_a_second_dns_answer(monkeypatch):
    """DNS rebinding: validation resolves the host once; the actual request
    must be pinned to that vetted address (with the original hostname kept
    in the Host header), so a different answer at connect time is unreachable."""
    pinned_url, headers, extensions = app_module._pinned_request(
        "http://public.example:8080/ep.mp3?tok=1", "93.184.216.34"
    )
    assert pinned_url == "http://93.184.216.34:8080/ep.mp3?tok=1"
    assert headers["host"] == "public.example:8080"
    assert extensions == {}

    https_url, https_headers, https_extensions = app_module._pinned_request(
        "https://public.example/ep.mp3", "2606:2800:220:1:248:1893:25c8:1946"
    )
    assert https_url == "https://[2606:2800:220:1:248:1893:25c8:1946]/ep.mp3"
    assert https_headers["host"] == "public.example"
    assert https_extensions == {"sni_hostname": "public.example"}


def test_validator_returns_the_pinned_address(monkeypatch):
    _patch_resolve_host(monkeypatch, {"public.example": ["93.184.216.34"]})
    assert app_module._validate_audio_url_sync("http://public.example/ep.mp3") == "93.184.216.34"


# --- Audio size ceiling -------------------------------------------------------


def test_oversized_multipart_upload_rejected_with_413_and_no_leaked_file(monkeypatch):
    from fastapi.testclient import TestClient

    monkeypatch.setenv("WORKER_TOKEN", "size-limit-token")
    monkeypatch.setenv("MAX_AUDIO_BYTES", "10")
    headers = {"authorization": "Bearer size-limit-token"}

    tmp_dir = pathlib.Path(tempfile.gettempdir())
    before = {p.name for p in tmp_dir.glob("whisperx-worker-*")}

    with TestClient(app_module.app) as size_client:
        response = size_client.post(
            "/transcribe", headers=headers, files={"file": ("episode.mp3", b"x" * 1024, "audio/mpeg")}
        )
        assert response.status_code == 413

    after = {p.name for p in tmp_dir.glob("whisperx-worker-*")}
    assert after == before


def test_oversized_multipart_content_length_rejected_before_body_parse(monkeypatch):
    """The declared Content-Length is enforced BEFORE Starlette parses (and
    spools) the multipart body, so an oversized request cannot consume
    request-time temp storage first."""
    from fastapi.testclient import TestClient

    monkeypatch.setenv("WORKER_TOKEN", "prelimit-token")
    monkeypatch.setenv("MAX_AUDIO_BYTES", "10")
    headers = {
        "authorization": "Bearer prelimit-token",
        "content-type": "multipart/form-data; boundary=deadbeef",
        "content-length": str(50 * 1024 * 1024),
    }
    with TestClient(app_module.app) as pre_client:
        response = pre_client.post("/transcribe", headers=headers, content=b"")
        assert response.status_code == 413


def test_multipart_without_content_length_is_rejected(monkeypatch):
    from fastapi.testclient import TestClient

    monkeypatch.setenv("WORKER_TOKEN", "nolen-token")
    headers = {
        "authorization": "Bearer nolen-token",
        "content-type": "multipart/form-data; boundary=deadbeef",
        "transfer-encoding": "chunked",
    }
    with TestClient(app_module.app) as nolen_client:
        response = nolen_client.post("/transcribe", headers=headers, content=iter([b"x"]))
        assert response.status_code == 411


def test_oversized_audio_url_download_marks_job_failed_and_leaves_no_temp_file(monkeypatch):
    from fastapi.testclient import TestClient

    monkeypatch.setenv("WORKER_TOKEN", "url-size-token")
    monkeypatch.setenv("MAX_AUDIO_BYTES", "10")
    headers = {"authorization": "Bearer url-size-token"}
    _patch_resolve_host(monkeypatch, {"big.example": ["93.184.216.34"]})

    class _BigResponse:
        status_code = 200
        headers: dict = {}

        def raise_for_status(self):
            return None

        async def aiter_bytes(self):
            yield b"x" * 1024

    class _BigStreamCtx:
        async def __aenter__(self):
            return _BigResponse()

        async def __aexit__(self, exc_type, exc, tb):
            return False

    class _BigAsyncClient:
        def __init__(self, *args, **kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, exc_type, exc, tb):
            return False

        def stream(self, method, url, **kwargs):
            return _BigStreamCtx()

    tmp_dir = pathlib.Path(tempfile.gettempdir())
    before = {p.name for p in tmp_dir.glob("whisperx-worker-*")}

    with TestClient(app_module.app) as size_client:
        monkeypatch.setattr(app_module.httpx, "AsyncClient", _BigAsyncClient)
        submitted = size_client.post(
            "/transcribe", headers=headers, json={"audio_url": "http://big.example/huge.mp3"}
        )
        job_id = submitted.json()["job_id"]
        body = wait_for_status(size_client, job_id, headers, "failed")
        assert "MAX_AUDIO_BYTES" in body["error"]

    after = {p.name for p in tmp_dir.glob("whisperx-worker-*")}
    assert after == before


# --- Terminal job retention ----------------------------------------------------


def test_completed_jobs_beyond_cap_are_evicted(monkeypatch):
    from fastapi.testclient import TestClient

    monkeypatch.setenv("WORKER_TOKEN", "retention-token")
    monkeypatch.setenv("MAX_QUEUED_JOBS", "10")
    monkeypatch.setenv("MAX_COMPLETED_JOBS", "2")
    headers = {"authorization": "Bearer retention-token"}

    async def fake_stage_audio(audio_url, staged_path, settings):
        return staged_path or "/tmp/fake-staged-audio-retention.mp3"

    with TestClient(app_module.app) as retention_client:
        monkeypatch.setattr(app_module, "_stage_audio", fake_stage_audio)
        monkeypatch.setattr(app_module, "whisperx_transcribe", _fake_backend())

        job_ids = []
        for i in range(3):
            response = retention_client.post(
                "/transcribe", headers=headers, json={"audio_url": f"https://example.com/{i}.mp3"}
            )
            job_id = response.json()["job_id"]
            wait_for_status(retention_client, job_id, headers, "completed")
            job_ids.append(job_id)

        oldest = retention_client.get(f"/jobs/{job_ids[0]}", headers=headers)
        assert oldest.status_code == 404

        newest = retention_client.get(f"/jobs/{job_ids[-1]}", headers=headers)
        assert newest.status_code == 200
        assert newest.json()["status"] == "completed"
