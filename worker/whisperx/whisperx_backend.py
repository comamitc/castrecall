"""WhisperX transcription, isolated behind one function.

`transcribe()` is the only seam the rest of the worker touches, and it
imports `whisperx` lazily (inside the function body, not at module scope) so
this module — and everything that imports it — can be loaded and mocked in
tests with no GPU, no CUDA, and no WhisperX/torch installation present.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Optional


@dataclass(frozen=True)
class TranscribeOptions:
    model: str
    language: Optional[str] = None
    batch_size: int = 16
    compute_type: str = "float16"
    timestamps: bool = True
    diarize: bool = False


def transcribe(audio_path: str, opts: TranscribeOptions, hf_token: Optional[str]) -> dict:
    """Runs WhisperX end-to-end: load model, transcribe, optionally align
    for word timestamps, optionally diarize. Returns a raw result dict with
    `segments`, `model`, `implementation`, `duration`, `warnings` — the
    caller (`app.py`) normalizes this into the remote-stt wire contract.
    """
    import whisperx  # type: ignore

    device = "cuda"
    model = whisperx.load_model(opts.model, device, compute_type=opts.compute_type, language=opts.language)
    audio = whisperx.load_audio(audio_path)
    result = model.transcribe(audio, batch_size=opts.batch_size)
    language = result.get("language", opts.language)

    warnings: list[str] = []

    if opts.timestamps:
        align_model, align_metadata = whisperx.load_align_model(language_code=language, device=device)
        result = whisperx.align(
            result["segments"], align_model, align_metadata, audio, device, return_char_alignments=False
        )

    if opts.diarize:
        if not hf_token:
            # Diarization needs a HuggingFace token to fetch the pyannote
            # speaker-diarization model. Requested-but-unavailable degrades
            # to a plain transcript with a warning, never a 500 — the
            # transcript itself is still useful without speaker labels.
            warnings.append(
                "diarize was requested but HF_TOKEN is not set; returning the transcript without speaker labels."
            )
        else:
            diarize_model = whisperx.DiarizationPipeline(use_auth_token=hf_token, device=device)
            diarize_segments = diarize_model(audio)
            result = whisperx.assign_word_speakers(diarize_segments, result)

    segments = []
    duration = 0.0
    for seg in result.get("segments", []):
        end = seg.get("end")
        if isinstance(end, (int, float)):
            duration = max(duration, end)
        segments.append(
            {
                "speaker": seg.get("speaker"),
                "text": (seg.get("text") or "").strip(),
                "start": seg.get("start"),
                "end": end,
            }
        )

    return {
        "segments": segments,
        "model": opts.model,
        "implementation": "whisperx",
        "duration": duration,
        "warnings": warnings,
    }
