"""Environment resolution for the WhisperX reference worker (issue #62).

Mirrors the DI style of the TypeScript side (`resolveConfig` in
`src/config.ts`): a pure function from an env mapping to a typed settings
object, never a module-level cached singleton, so tests can resolve settings
against an arbitrary env without mutating `os.environ` or restarting a
process.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Mapping, Optional


class ConfigError(RuntimeError):
    """Raised when the worker cannot start with the given environment."""


@dataclass(frozen=True)
class Settings:
    bind_host: str
    port: int
    token: str
    model: str
    language: Optional[str]
    batch_size: int
    compute_type: str
    diarize: bool
    hf_token: Optional[str]
    delete_audio: bool
    max_active_jobs: int
    max_queued_jobs: int


def _bool(raw: Optional[str], default: bool) -> bool:
    if raw is None or raw.strip() == "":
        return default
    return raw.strip().lower() in ("1", "true", "yes", "on")


def _int(raw: Optional[str], default: int) -> int:
    if raw is None or raw.strip() == "":
        return default
    return int(raw)


def load_settings(env: Optional[Mapping[str, str]] = None) -> Settings:
    """Resolve worker settings from the environment.

    Raises `ConfigError` when `WORKER_TOKEN` is unset — the worker refuses to
    start unauthenticated rather than silently exposing a GPU transcription
    endpoint.
    """
    source = env if env is not None else os.environ
    token = (source.get("WORKER_TOKEN") or "").strip()
    if not token:
        raise ConfigError(
            "WORKER_TOKEN is required — set it to a private bearer token before starting the worker. "
            "Every endpoint (including /health) requires 'Authorization: Bearer <token>'."
        )
    return Settings(
        bind_host=source.get("WORKER_BIND_HOST") or "127.0.0.1",
        port=_int(source.get("WORKER_PORT"), 8000),
        token=token,
        model=source.get("WHISPERX_MODEL") or "large-v3",
        language=source.get("WHISPERX_LANGUAGE") or None,
        batch_size=_int(source.get("WHISPERX_BATCH_SIZE"), 16),
        compute_type=source.get("WHISPERX_COMPUTE_TYPE") or "float16",
        diarize=_bool(source.get("WHISPERX_DIARIZE"), False),
        hf_token=source.get("HF_TOKEN") or None,
        delete_audio=_bool(source.get("DELETE_AUDIO"), True),
        max_active_jobs=_int(source.get("MAX_ACTIVE_JOBS"), 1),
        max_queued_jobs=_int(source.get("MAX_QUEUED_JOBS"), 16),
    )
