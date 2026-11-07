"""Tests for audio format normalization and provider compatibility."""
from pathlib import Path
from unittest.mock import MagicMock, patch

import numpy as np
import soundfile as sf

from virasya_ai.transcription.ingestion.audio import (
    PROVIDER_SUPPORTED_SUFFIXES,
    prepare_provider_audio,
)
from virasya_ai.transcription.service import GnaniTranscriptionService


def test_provider_supported_suffixes_pass_through_directly(tmp_path: Path):
    """Files in PROVIDER_SUPPORTED_SUFFIXES must not be converted or modified."""
    for ext in [".wav", ".ogg", ".flac"]:
        test_file = tmp_path / f"sample{ext}"
        # Create a valid minimal audio file
        data = np.zeros((1600, 1), dtype=np.float32)
        sf.write(str(test_file), data, 16000)

        with prepare_provider_audio(test_file) as effective_path:
            assert effective_path == test_file
            assert effective_path.suffix.lower() == ext
            assert effective_path.exists()

        # Original file remains untouched
        assert test_file.exists()


def test_unsupported_format_converted_and_cleaned_up(tmp_path: Path):
    """WebM files must be converted to PCM WAV and cleaned up after context exit."""
    # Create a source WAV first, then convert to webm using ffmpeg for testing
    import subprocess
    src_wav = tmp_path / "source.wav"
    data = np.zeros((1600, 1), dtype=np.float32)
    sf.write(str(src_wav), data, 16000)

    webm_file = tmp_path / "recording.webm"
    subprocess.run(
        ["ffmpeg", "-y", "-v", "error", "-i", str(src_wav), "-c:a", "libopus", str(webm_file)],
        check=True,
    )
    assert webm_file.exists()

    yielded_path: Path | None = None
    with prepare_provider_audio(webm_file) as effective_path:
        yielded_path = effective_path
        assert yielded_path.exists()
        assert yielded_path != webm_file
        assert yielded_path.suffix.lower() == ".wav"

        # Verify that yielded file is a valid 16kHz mono WAV
        info = sf.info(str(yielded_path))
        assert info.samplerate == 16000
        assert info.channels == 1
        assert info.format == "WAV"
        assert info.subtype == "PCM_16"

    # Context exit must delete the temporary WAV
    assert yielded_path is not None
    assert not yielded_path.exists()
    # Original webm file remains intact
    assert webm_file.exists()


def test_gnani_service_dispatches_converted_wav_for_webm(tmp_path: Path):
    """GnaniTranscriptionService must send WAV to Gnani when given a WebM file."""
    import subprocess
    src_wav = tmp_path / "source2.wav"
    data = np.zeros((1600, 1), dtype=np.float32)
    sf.write(str(src_wav), data, 16000)

    webm_file = tmp_path / "recorded_voice.webm"
    subprocess.run(
        ["ffmpeg", "-y", "-v", "error", "-i", str(src_wav), "-c:a", "libopus", str(webm_file)],
        check=True,
    )

    service = GnaniTranscriptionService()
    mock_response = MagicMock()
    mock_response.status_code = 200
    mock_response.json.return_value = {
        "success": True,
        "transcript": "परीक्षण संदेश",
    }

    dispatched_files = {}

    def mock_post(url, headers=None, data=None, files=None, timeout=None):
        nonlocal dispatched_files
        dispatched_files = files
        # Check that the file object is valid and readable
        assert "audio_file" in files
        fname, handle, content_type = files["audio_file"]
        assert fname.endswith(".wav")
        assert content_type == "audio/wav"
        data_read = handle.read(12)
        assert data_read.startswith(b"RIFF")
        return mock_response

    with patch.object(service.session, "post", side_effect=mock_post):
        with patch("virasya_ai.transcription.service.get_gnani_api_key", return_value="test_key"):
            res = service.transcribe(webm_file, language_code="hi-IN")

    assert res.text == "परीक्षण संदेश"
    assert "audio_file" in dispatched_files
