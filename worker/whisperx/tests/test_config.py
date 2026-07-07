import pytest

from config import ConfigError, load_settings


def test_refuses_to_start_without_worker_token():
    with pytest.raises(ConfigError, match="WORKER_TOKEN"):
        load_settings({})


def test_refuses_to_start_with_blank_worker_token():
    with pytest.raises(ConfigError, match="WORKER_TOKEN"):
        load_settings({"WORKER_TOKEN": "   "})


def test_defaults_when_only_token_is_set():
    settings = load_settings({"WORKER_TOKEN": "secret"})
    assert settings.token == "secret"
    assert settings.bind_host == "127.0.0.1"
    assert settings.port == 8000
    assert settings.model == "large-v3"
    assert settings.language is None
    assert settings.batch_size == 16
    assert settings.compute_type == "float16"
    assert settings.diarize is False
    assert settings.hf_token is None
    assert settings.delete_audio is True
    assert settings.max_active_jobs == 1
    assert settings.max_queued_jobs == 16


def test_overrides_are_applied():
    settings = load_settings(
        {
            "WORKER_TOKEN": "secret",
            "WORKER_BIND_HOST": "0.0.0.0",
            "WORKER_PORT": "9000",
            "WHISPERX_MODEL": "medium",
            "WHISPERX_LANGUAGE": "en",
            "WHISPERX_BATCH_SIZE": "8",
            "WHISPERX_COMPUTE_TYPE": "int8",
            "WHISPERX_DIARIZE": "true",
            "HF_TOKEN": "hf-secret",
            "DELETE_AUDIO": "false",
            "MAX_ACTIVE_JOBS": "2",
            "MAX_QUEUED_JOBS": "32",
        }
    )
    assert settings.bind_host == "0.0.0.0"
    assert settings.port == 9000
    assert settings.model == "medium"
    assert settings.language == "en"
    assert settings.batch_size == 8
    assert settings.compute_type == "int8"
    assert settings.diarize is True
    assert settings.hf_token == "hf-secret"
    assert settings.delete_audio is False
    assert settings.max_active_jobs == 2
    assert settings.max_queued_jobs == 32
