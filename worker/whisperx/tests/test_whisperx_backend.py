"""Unit tests for whisperx_backend.transcribe() against a fake `whisperx`
module (injected via sys.modules) so the real package/GPU is never required.
"""

import sys
import types

import pytest

from whisperx_backend import TranscribeOptions, transcribe


class FakeModel:
    def transcribe(self, audio, batch_size):
        return {
            "segments": [{"start": 0.0, "end": 1.5, "text": " hi there "}],
            "language": "en",
        }


def _install_fake_whisperx(monkeypatch, *, diarize_assigns_speaker=True):
    calls = {"align": 0, "diarize": 0}

    def load_model(model, device, compute_type=None, language=None):
        assert device == "cuda"
        return FakeModel()

    def load_audio(path):
        return f"audio:{path}"

    def load_align_model(language_code, device):
        calls["align"] += 1
        return object(), object()

    def align(segments, align_model, metadata, audio, device, return_char_alignments=False):
        return {"segments": segments}

    class DiarizationPipeline:
        def __init__(self, use_auth_token, device):
            self.use_auth_token = use_auth_token

        def __call__(self, audio):
            calls["diarize"] += 1
            return "diarize-segments"

    def assign_word_speakers(diarize_segments, result):
        if diarize_assigns_speaker:
            for seg in result["segments"]:
                seg["speaker"] = 0
        return result

    fake = types.ModuleType("whisperx")
    fake.load_model = load_model
    fake.load_audio = load_audio
    fake.load_align_model = load_align_model
    fake.align = align
    fake.DiarizationPipeline = DiarizationPipeline
    fake.assign_word_speakers = assign_word_speakers
    monkeypatch.setitem(sys.modules, "whisperx", fake)
    return calls


def test_transcribe_returns_normalized_shape(monkeypatch):
    _install_fake_whisperx(monkeypatch)
    opts = TranscribeOptions(model="large-v3")
    result = transcribe("/tmp/audio.mp3", opts, hf_token=None)
    assert result["model"] == "large-v3"
    assert result["implementation"] == "whisperx"
    assert result["duration"] == 1.5
    assert result["segments"] == [{"speaker": None, "text": "hi there", "start": 0.0, "end": 1.5}]
    assert result["warnings"] == []


def test_timestamps_true_runs_alignment(monkeypatch):
    calls = _install_fake_whisperx(monkeypatch)
    opts = TranscribeOptions(model="large-v3", timestamps=True)
    transcribe("/tmp/audio.mp3", opts, hf_token=None)
    assert calls["align"] == 1


def test_timestamps_false_skips_alignment(monkeypatch):
    calls = _install_fake_whisperx(monkeypatch)
    opts = TranscribeOptions(model="large-v3", timestamps=False)
    transcribe("/tmp/audio.mp3", opts, hf_token=None)
    assert calls["align"] == 0


def test_diarize_without_hf_token_warns_instead_of_failing(monkeypatch):
    calls = _install_fake_whisperx(monkeypatch)
    opts = TranscribeOptions(model="large-v3", diarize=True)
    result = transcribe("/tmp/audio.mp3", opts, hf_token=None)
    assert calls["diarize"] == 0
    assert result["warnings"] == [
        "diarize was requested but HF_TOKEN is not set; returning the transcript without speaker labels."
    ]
    # Still a usable transcript — no speaker labels, not an empty result.
    assert result["segments"][0]["text"] == "hi there"


def test_diarize_with_hf_token_assigns_speakers(monkeypatch):
    calls = _install_fake_whisperx(monkeypatch)
    opts = TranscribeOptions(model="large-v3", diarize=True)
    result = transcribe("/tmp/audio.mp3", opts, hf_token="hf-secret")
    assert calls["diarize"] == 1
    assert result["warnings"] == []
    assert result["segments"][0]["speaker"] == 0
