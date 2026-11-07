"""Gnani Prisma v2.5 REST speech-to-text client.

This implements the documented Prisma REST contract. It is not an OmniRush
Astra client; Astra compatibility and access are not verified here.
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import requests

from virasya_ai.config import (
    DEFAULT_LANGUAGE,
    get_gnani_api_key,
    get_gnani_timeout,
)
from virasya_ai.exceptions import (
    MissingApiKeyError,
    ProviderAuthenticationError,
    ProviderConnectionError,
    ProviderLanguageError,
    ProviderRateLimitError,
    ProviderRequestError,
    ProviderResponseError,
    ProviderTimeoutError,
    ProviderUnavailableError,
)
from virasya_ai.transcription.base import TranscriptResult
from virasya_ai.transcription.ingestion.audio import (
    prepare_provider_audio,
    validate_audio_file,
)


class GnaniTranscriptionService:
    """Documented Gnani Prisma v2.5 REST client for short Hindi clips."""

    provider_name = "gnani-prisma-v2.5"
    language = DEFAULT_LANGUAGE
    endpoint = "https://api.vachana.ai/stt/v3"
    language_code = "hi-IN"
    output_format = "verbatim"

    def __init__(
        self,
        *,
        timeout: float | None = None,
        session: requests.Session | None = None,
    ) -> None:
        self.timeout = timeout if timeout is not None else get_gnani_timeout()
        self.session = session or requests.Session()

    def close(self) -> None:
        """Close the underlying HTTP session."""
        self.session.close()

    def __enter__(self) -> "GnaniTranscriptionService":
        return self

    def __exit__(self, exc_type, exc_value, traceback) -> None:
        self.close()

    def transcribe(
        self,
        audio_path: str | Path,
        *,
        language_code: str = "hi-IN",
        metadata: dict[str, Any] | None = None,
    ) -> TranscriptResult:
        del metadata
        api_key = get_gnani_api_key()
        if api_key is None:
            raise MissingApiKeyError(
                "GNANI_API_KEY is not set. Configure the provider credential "
                "before requesting transcription."
            )

        path = validate_audio_file(audio_path)
        with prepare_provider_audio(path) as effective_path:
            try:
                with effective_path.open("rb") as audio_handle:
                    response = self.session.post(
                        self.endpoint,
                        headers={"X-API-Key-ID": api_key},
                        data={
                            "language_code": language_code,
                            "format": self.output_format,
                        },
                        files={
                            "audio_file": (
                                effective_path.name,
                                audio_handle,
                                _content_type(effective_path),
                            )
                        },
                        timeout=self.timeout,
                    )
            except requests.Timeout as exc:
                raise ProviderTimeoutError(
                    f"Gnani transcription timed out after {self.timeout:g} seconds."
                ) from exc
            except requests.ConnectionError as exc:
                raise ProviderConnectionError(
                    "Could not connect to the Gnani transcription service."
                ) from exc
            except requests.RequestException as exc:
                raise ProviderRequestError(
                    "The Gnani transcription request could not be completed."
                ) from exc

        try:
            if response.status_code != 200:
                raise _http_error(response, api_key)

            try:
                payload = response.json()
            except (ValueError, json.JSONDecodeError) as exc:
                raise ProviderResponseError(
                    "Gnani returned a malformed JSON response."
                ) from exc

            if not isinstance(payload, dict) or payload.get("success") is not True:
                raise ProviderResponseError(
                    _provider_message(
                        _redact(payload, api_key),
                        "Gnani rejected the transcription request.",
                    )
                )
            transcript = payload.get("transcript")
            if not isinstance(transcript, str) or not transcript.strip():
                raise ProviderResponseError(
                    "Gnani returned a successful response without a transcript."
                )
            return TranscriptResult(
                text=transcript.strip(),
                language=self.language,
                provider=self.provider_name,
                provider_metadata={
                    "request_id": payload.get("request_id"),
                    "timestamp": payload.get("timestamp"),
                    "language_code": language_code,
                },
            )
        finally:
            response.close()


def _content_type(path: Path) -> str:
    return {
        ".wav": "audio/wav",
        ".mp3": "audio/mpeg",
        ".ogg": "audio/ogg",
        ".flac": "audio/flac",
        ".aac": "audio/aac",
        ".m4a": "audio/mp4",
        ".webm": "audio/webm",
    }.get(path.suffix.lower(), "application/octet-stream")


def _safe_response_payload(response: requests.Response, api_key: str) -> Any:
    try:
        payload = response.json()
    except (ValueError, json.JSONDecodeError):
        payload = response.text[:300]
    return _redact(payload, api_key)


def _redact(value: Any, secret: str) -> Any:
    if isinstance(value, str):
        return value.replace(secret, "[REDACTED]")
    if isinstance(value, dict):
        return {key: _redact(item, secret) for key, item in value.items()}
    if isinstance(value, list):
        return [_redact(item, secret) for item in value]
    return value


def _provider_message(payload: Any, fallback: str) -> str:
    if isinstance(payload, dict):
        error = payload.get("error")
        if isinstance(error, dict) and isinstance(error.get("message"), str):
            return error["message"][:300]
        if isinstance(error, str):
            return error[:300]
        if isinstance(payload.get("message"), str):
            return payload["message"][:300]
        detail = payload.get("detail")
        if isinstance(detail, str):
            return detail[:300]
        if isinstance(detail, dict) and isinstance(detail.get("message"), str):
            return detail["message"][:300]
        if isinstance(detail, list):
            parts = [
                d.get("msg", str(d)) if isinstance(d, dict) else str(d)
                for d in detail
            ]
            return ", ".join(parts)[:300]
    return fallback


def _http_error(response: requests.Response, api_key: str) -> Exception:
    payload = _safe_response_payload(response, api_key)
    message = _provider_message(
        payload,
        f"Gnani returned HTTP {response.status_code}.",
    )
    if response.status_code in (401, 403):
        return ProviderAuthenticationError(
            f"Gnani authentication or permission failed (HTTP {response.status_code}). {message}"
        )
    if response.status_code == 400:
        error_type = ""
        if isinstance(payload, dict) and isinstance(payload.get("error"), dict):
            error_type = str(payload["error"].get("type", "")).upper()
        if "LANGUAGE" in error_type or "UNSUPPORTED" in error_type:
            return ProviderLanguageError(f"Gnani does not support the selected language. {message}")
        return ProviderRequestError(f"Gnani rejected the audio request. {message}")
    if response.status_code == 429:
        return ProviderRateLimitError(f"Gnani rate limit reached. {message}")
    if response.status_code in (500, 503):
        return ProviderUnavailableError(f"Gnani transcription service unavailable. {message}")
    return ProviderRequestError(f"Gnani request failed (HTTP {response.status_code}). {message}")
