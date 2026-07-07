import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

import pytest
from fastapi.testclient import TestClient

import app as app_module

TOKEN = "test-token-123"


@pytest.fixture
def token() -> str:
    return TOKEN


@pytest.fixture
def auth_headers(token) -> dict[str, str]:
    return {"authorization": f"Bearer {token}"}


@pytest.fixture
def client(monkeypatch, token):
    monkeypatch.setenv("WORKER_TOKEN", token)
    monkeypatch.setenv("MAX_ACTIVE_JOBS", "1")
    monkeypatch.setenv("MAX_QUEUED_JOBS", "16")
    monkeypatch.delenv("HF_TOKEN", raising=False)
    monkeypatch.setattr(app_module, "whisperx_check_readiness", lambda model, compute_type: (True, None))
    with TestClient(app_module.app) as test_client:
        yield test_client


@pytest.fixture
def client_with_diarization(monkeypatch, token):
    monkeypatch.setenv("WORKER_TOKEN", token)
    monkeypatch.setenv("MAX_ACTIVE_JOBS", "1")
    monkeypatch.setenv("MAX_QUEUED_JOBS", "16")
    monkeypatch.setenv("WHISPERX_DIARIZE", "true")
    monkeypatch.delenv("HF_TOKEN", raising=False)
    monkeypatch.setattr(app_module, "whisperx_check_readiness", lambda model, compute_type: (True, None))
    with TestClient(app_module.app) as test_client:
        yield test_client


def wait_for_status(client, job_id: str, headers: dict[str, str], status: str, timeout: float = 5.0) -> dict:
    import time

    deadline = time.monotonic() + timeout
    last: dict = {}
    while time.monotonic() < deadline:
        response = client.get(f"/jobs/{job_id}", headers=headers)
        last = response.json()
        if last.get("status") == status:
            return last
        time.sleep(0.02)
    raise AssertionError(f"job {job_id} never reached status {status!r}; last body: {last}")
