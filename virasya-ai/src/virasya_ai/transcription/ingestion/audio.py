"""Reusable local audio validation and optional normalization helpers."""
from __future__ import annotations

import io
import subprocess
import tempfile
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Generator

import numpy as np
import soundfile as sf
import soxr

from virasya_ai.config import DEFAULT_SAMPLE_RATE
from virasya_ai.exceptions import (
    AudioTooLongError,
    CorruptAudioError,
    EmptyAudioError,
    MissingAudioError,
    UnsupportedFormatError,
)

SUPPORTED_SUFFIXES = {
    ".wav",
    ".flac",
    ".ogg",
    ".mp3",
    ".m4a",
    ".aac",
    ".webm",
}
# Formats directly accepted by Gnani Prisma STT REST API
PROVIDER_SUPPORTED_SUFFIXES = {
    ".wav",
    ".ogg",
    ".mp3",
    ".m4a",
    ".aac",
    ".flac",
}
MAX_DURATION_SECONDS = 60.0
_FFMPEG_FALLBACK_SUFFIXES = {".mp3", ".m4a", ".aac", ".webm"}


@dataclass
class DecodedAudio:
    """Audio decoded to mono float32 at a requested sample rate."""

    samples: np.ndarray
    path: str
    duration_sec: float
    original_sample_rate: int
    channels: int
    sample_rate: int = DEFAULT_SAMPLE_RATE


def _check_audio_path(audio_path: str | Path) -> Path:
    path = Path(audio_path)
    if not path.exists():
        raise MissingAudioError(f"Audio file not found: {path}")
    if not path.is_file():
        raise MissingAudioError(f"Not a file: {path}")
    if path.stat().st_size == 0:
        raise EmptyAudioError(f"Audio file is empty: {path}")
    if path.suffix.lower() not in SUPPORTED_SUFFIXES:
        raise UnsupportedFormatError(
            f"Unsupported format {path.suffix}. Supported formats: "
            f"{', '.join(sorted(SUPPORTED_SUFFIXES))}."
        )
    return path


def _ffmpeg_decode(path: Path) -> tuple[np.ndarray, int]:
    try:
        process = subprocess.run(
            [
                "ffmpeg",
                "-v",
                "error",
                "-i",
                str(path),
                "-f",
                "wav",
                "-acodec",
                "pcm_s16le",
                "pipe:1",
            ],
            check=False,
            capture_output=True,
            timeout=30.0,
        )
    except FileNotFoundError as exc:
        raise UnsupportedFormatError(
            f"Cannot decode {path.suffix} without ffmpeg. Install ffmpeg or "
            "provide WAV, FLAC, or OGG audio."
        ) from exc
    except subprocess.TimeoutExpired as exc:
        raise CorruptAudioError(f"Audio decoding timed out for {path.name}") from exc

    if process.returncode != 0:
        detail = process.stderr.decode(errors="ignore")[:200]
        raise CorruptAudioError(
            f"Could not decode {path.name} with ffmpeg: {detail}"
        )

    # Bound maximum decoded audio bytes to 25 MiB (~2 minutes of 48kHz 16-bit stereo)
    max_decoded_bytes = 25 * 1024 * 1024
    if len(process.stdout) > max_decoded_bytes:
        raise AudioTooLongError(
            f"Decoded audio stream ({len(process.stdout)} bytes) exceeds the maximum allowed size ({max_decoded_bytes} bytes)."
        )

    try:
        data, rate = sf.read(io.BytesIO(process.stdout), always_2d=True, dtype="float32")
    except Exception as exc:
        raise CorruptAudioError(f"Could not decode audio file: {path.name}") from exc
    return data, int(rate)


def convert_to_pcm_wav(input_path: Path, output_path: Path) -> None:
    """Convert any supported audio file to standard 16kHz mono 16-bit PCM WAV using ffmpeg."""
    try:
        process = subprocess.run(
            [
                "ffmpeg",
                "-y",
                "-v",
                "error",
                "-i",
                str(input_path),
                "-ar",
                "16000",
                "-ac",
                "1",
                "-c:a",
                "pcm_s16le",
                str(output_path),
            ],
            check=False,
            capture_output=True,
            timeout=30.0,
        )
    except FileNotFoundError as exc:
        raise UnsupportedFormatError(
            f"Cannot convert {input_path.suffix} without ffmpeg installed."
        ) from exc
    except subprocess.TimeoutExpired as exc:
        raise CorruptAudioError(
            f"Audio conversion timed out for {input_path.name}."
        ) from exc

    if process.returncode != 0:
        detail = process.stderr.decode(errors="ignore")[:200]
        raise CorruptAudioError(
            f"Could not convert {input_path.name} to WAV: {detail}"
        )


@contextmanager
def prepare_provider_audio(path: Path) -> Generator[Path, None, None]:
    """Yield a path to an audio file in a format accepted by the ASR provider.

    If the input format is already supported by the provider (.wav, .ogg, .mp3, .m4a, .aac, .flac),
    it is yielded directly with zero conversion overhead.
    If the format is not directly accepted (e.g. .webm), it is converted to a temporary 16kHz mono
    PCM WAV file, yielded for dispatch, and guaranteed to be deleted upon context exit.
    """
    clean_path = _check_audio_path(path)
    if clean_path.suffix.lower() in PROVIDER_SUPPORTED_SUFFIXES:
        yield clean_path
        return

    # Normalization required for provider compatibility (e.g. browser WebM recordings)
    temp_wav: Path | None = None
    try:
        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tf:
            temp_wav = Path(tf.name)
        convert_to_pcm_wav(clean_path, temp_wav)
        yield temp_wav
    finally:
        if temp_wav is not None:
            temp_wav.unlink(missing_ok=True)


def _read_audio(path: Path) -> tuple[np.ndarray, int]:
    try:
        data, rate = sf.read(str(path), always_2d=True, dtype="float32")
        return data, int(rate)
    except RuntimeError as exc:
        if path.suffix.lower() in _FFMPEG_FALLBACK_SUFFIXES:
            return _ffmpeg_decode(path)
        raise CorruptAudioError(f"Could not decode audio file: {path.name}") from exc


def audio_duration_seconds(audio_path: str | Path) -> float:
    """Return duration in seconds, using metadata without changing the file."""
    path = _check_audio_path(audio_path)
    try:
        info = sf.info(str(path))
        duration = float(info.duration)
        if duration > 0:
            return duration
    except RuntimeError:
        pass

    try:
        samples, rate = _read_audio(path)
    except (CorruptAudioError, UnsupportedFormatError):
        raise
    except Exception as exc:
        raise CorruptAudioError(f"Could not decode audio file: {path.name}") from exc
    if samples.size == 0:
        raise EmptyAudioError(f"Audio contains no samples: {path}")
    duration = float(samples.shape[0] / rate)
    if duration <= 0:
        raise EmptyAudioError(f"Audio duration is zero: {path}")
    return duration


def validate_audio_file(
    audio_path: str | Path,
    *,
    max_duration_seconds: float | None = MAX_DURATION_SECONDS,
) -> Path:
    """Validate path, format, decodability, and the provider duration limit."""
    path = _check_audio_path(audio_path)
    duration = audio_duration_seconds(path)
    if max_duration_seconds is not None and duration > max_duration_seconds:
        raise AudioTooLongError(
            f"Audio is {duration:.1f} seconds; the REST provider accepts at most "
            f"{max_duration_seconds:.0f} seconds."
        )
    return path


def load_audio(
    audio_path: str | Path,
    *,
    target_sr: int = DEFAULT_SAMPLE_RATE,
) -> DecodedAudio:
    """Decode supported audio to mono float32 at ``target_sr`` in memory."""
    path = _check_audio_path(audio_path)
    try:
        samples, rate = _read_audio(path)
    except (AudioTooLongError, CorruptAudioError, UnsupportedFormatError, EmptyAudioError):
        raise
    except Exception as exc:
        raise CorruptAudioError(f"Could not decode audio file: {path.name}") from exc

    if samples.size == 0:
        raise EmptyAudioError(f"Audio contains no samples: {path}")
    channels = samples.shape[1]
    mono = samples.mean(axis=1)
    if rate != target_sr:
        mono = soxr.resample(mono, rate, target_sr)
    mono = np.ascontiguousarray(mono, dtype=np.float32)
    duration = float(len(mono) / target_sr)
    if duration <= 0:
        raise EmptyAudioError(f"Audio duration is zero: {path}")
    return DecodedAudio(
        samples=mono,
        path=str(path.resolve()),
        duration_sec=duration,
        original_sample_rate=rate,
        channels=channels,
        sample_rate=target_sr,
    )


def format_duration(seconds: float) -> str:
    total = int(round(seconds))
    hours, remainder = divmod(total, 3600)
    minutes, seconds = divmod(remainder, 60)
    if hours:
        return f"{hours:02d}:{minutes:02d}:{seconds:02d}"
    return f"{minutes:02d}:{seconds:02d}"
