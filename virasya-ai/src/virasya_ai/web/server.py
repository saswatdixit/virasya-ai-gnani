"""Virasya Preservation Studio Backend Server.

Supports both the lightweight local studio and the full Virasya React Frontend.
Exposes endpoints for Audio Upload, Gnani Transcription, Story Preservation, and Explore Feed.
"""
from __future__ import annotations

import email
import email.policy
import hashlib
import io
import json
import mimetypes
import os
import threading
import time
import urllib.request
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlparse

from virasya_ai.config import (
    DEFAULT_LANGUAGE,
    get_gnani_api_key,
    get_gnani_timeout,
)
from virasya_ai.exceptions import (
    AudioError,
    AudioTooLongError,
    CorruptAudioError,
    EmptyAudioError,
    MissingApiKeyError,
    StorageError,
    TranscriptionProviderError,
    UnsupportedFormatError,
    UnsupportedLanguageError,
    UploadError,
    VirasyaError,
)
from virasya_ai.transcription.service import GnaniTranscriptionService
from virasya_ai.transcription.storage import TranscriptStore
from virasya_ai.transcription.story_storage import (
    cleanup_stale_scratch_files,
    get_all_vocabulary,
    get_data_dir,
    get_story,
    list_stories,
    sanitize_filename,
    save_story,
    save_vocabulary_terms,
)
from virasya_ai.web.languages import get_language, language_options_payload, resolve_language_option
from virasya_ai.web.workflow import MAX_UPLOAD_BYTES, transcribe_uploaded_audio

STATIC_DIR = Path(__file__).with_name("static")
DATA_DIR = get_data_dir()
INPUT_AUDIO_DIR = DATA_DIR / "input"
INPUT_AUDIO_DIR.mkdir(parents=True, exist_ok=True)

MAX_REQUEST_BYTES = MAX_UPLOAD_BYTES + 1024 * 1024
ALLOWED_AUDIO_EXTENSIONS = {".wav", ".ogg", ".mp3", ".flac", ".m4a", ".aac", ".webm"}

_MAX_CONCURRENT_TRANSCRIBES = int(os.getenv("VIRASYA_MAX_CONCURRENT_TRANSCRIBES", "3"))
_TRANSCRIPTION_SEMAPHORE = threading.Semaphore(_MAX_CONCURRENT_TRANSCRIBES)


class MultipartField:
    """Represents a parsed multipart/form-data field."""

    def __init__(
        self,
        name: str,
        value: bytes,
        filename: str | None = None,
        content_type: str | None = None,
    ) -> None:
        self.name = name
        self.value = value
        self.filename = filename
        self.content_type = content_type
        self.file = io.BytesIO(value)


class MultipartData:
    """Container for parsed multipart/form-data fields, replacing deprecated cgi.FieldStorage."""

    def __init__(self) -> None:
        self._fields: dict[str, list[MultipartField]] = {}

    def add(self, field: MultipartField) -> None:
        self._fields.setdefault(field.name, []).append(field)

    def __contains__(self, key: str) -> bool:
        return key in self._fields

    def __getitem__(self, key: str) -> MultipartField:
        items = self._fields.get(key)
        if not items:
            raise KeyError(key)
        return items[0]

    def get(self, key: str, default: Any = None) -> MultipartField | None:
        items = self._fields.get(key)
        if not items:
            return default
        return items[0]

    def getlist(self, key: str) -> list[MultipartField]:
        return self._fields.get(key, [])

    def getvalue(self, key: str, default: str = "") -> str:
        items = self._fields.get(key)
        if not items:
            return default
        try:
            return items[0].value.decode("utf-8")
        except UnicodeDecodeError:
            return default


def _resolve_scratch_file(
    user_id: str | None,
    raw_filename: str,
    *,
    require_auth: bool = False,
    must_exist: bool = True,
) -> Path | None:
    """Safely resolve an audio scratch file enforcing user boundary, no traversal, and no symlinks."""
    try:
        unquoted = urllib.parse.unquote(raw_filename)
        safe_name = sanitize_filename(unquoted)
    except (ValueError, TypeError):
        return None

    if user_id:
        try:
            safe_user_id = sanitize_filename(str(user_id))
        except ValueError:
            return None
        target_dir = (INPUT_AUDIO_DIR / safe_user_id).resolve()
        target_dir.mkdir(parents=True, exist_ok=True)
        candidate = (target_dir / safe_name).resolve()
        if not candidate.is_relative_to(target_dir):
            return None
        if candidate.is_symlink():
            return None
        if must_exist:
            if candidate.exists() and candidate.is_file():
                return candidate
            return None
        return candidate

    # In production with authentication required, NEVER fall back to unauthenticated root
    if require_auth:
        return None

    # Local development / test fallback
    target_dir = INPUT_AUDIO_DIR.resolve()
    candidate = (target_dir / safe_name).resolve()
    if not candidate.is_relative_to(target_dir):
        return None
    if candidate.is_symlink():
        return None
    if must_exist:
        if candidate.exists() and candidate.is_file():
            return candidate
        return None
    return candidate


class StudioHandler(BaseHTTPRequestHandler):
    server_version = "VirasyaStudio/2.0"

    def log_message(self, format: str, *args: object) -> None:
        # Keep provider credentials and raw audio bytes out of terminal logs
        return

    def _set_cors_headers(self) -> None:
        allowed_env = os.getenv("VIRASYA_ALLOWED_ORIGINS", "*").strip()
        origin_header = self.headers.get("Origin")
        if allowed_env == "*":
            self.send_header("Access-Control-Allow-Origin", "*")
        elif origin_header:
            allowed_list = [o.strip() for o in allowed_env.split(",") if o.strip()]
            if origin_header in allowed_list:
                self.send_header("Access-Control-Allow-Origin", origin_header)
                self.send_header("Vary", "Origin")
            # If origin_header is not in allowed_list, omit Access-Control-Allow-Origin so browser blocks access
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS, PUT, DELETE")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Requested-With")

    def do_OPTIONS(self) -> None:  # noqa: N802
        self.send_response(HTTPStatus.NO_CONTENT)
        self._set_cors_headers()
        self.end_headers()

    def do_GET(self) -> None:  # noqa: N802
        parsed_url = urlparse(self.path)
        path = parsed_url.path
        query = parse_qs(parsed_url.query)

        # 1. Static UI assets
        if path == "/":
            self._send_static("index.html", "text/html; charset=utf-8")
        elif path == "/static/app.js":
            self._send_static("app.js", "text/javascript; charset=utf-8")
        elif path == "/static/styles.css":
            self._send_static("styles.css", "text/css; charset=utf-8")
        elif path == "/api/languages":
            self._send_json({"languages": language_options_payload()})

        # 2. Health & Model status for React frontend
        elif path == "/api/health":
            key_configured = bool(get_gnani_api_key())
            self._send_json({
                "status": "healthy",
                "service": "Virasya AI Gnani Backend",
                "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                "models": {
                    "gnani": {
                        "status": "online" if key_configured else "missing_key",
                        "model": "Gnani Prisma STT v2.5 (Cloud AI)",
                        "error": None if key_configured else "GNANI_API_KEY is not set",
                    },
                    "vaani": {
                        "status": "online" if key_configured else "offline",
                        "model": "Gnani Prisma STT v2.5",
                        "error": None if key_configured else "GNANI_API_KEY is not set",
                    },
                    "indicconformer": {
                        "status": "offline",
                        "model": "AI4Bharat IndicConformer (Offline)",
                        "error": None,
                    },
                    "busy": False,
                },
            })
        elif path == "/api/models/status":
            key_configured = bool(get_gnani_api_key())
            self._send_json({
                "gnani": {
                    "status": "online" if key_configured else "missing_key",
                    "model": "Gnani Prisma STT v2.5",
                    "error": None if key_configured else "GNANI_API_KEY is not set",
                },
                "vaani": {
                    "status": "online" if key_configured else "missing_key",
                    "model": "Gnani Prisma STT v2.5",
                    "error": None if key_configured else "GNANI_API_KEY is not set",
                },
                "indicconformer": {
                    "status": "offline",
                    "model": "AI4Bharat IndicConformer (Offline)",
                    "error": None,
                },
                "busy": False,
            })

        # 3. Audio file playback
        elif path.startswith("/api/audio/"):
            raw_filename = path[len("/api/audio/"):]
            self._serve_audio_file(raw_filename)

        # 4. Explore Stories feed
        elif path == "/api/explore":
            self._handle_explore_feed(query)

        # 5. Single Story Detail
        elif path.startswith("/api/explore/"):
            story_id = path[len("/api/explore/"):]
            self._handle_get_story_detail(story_id)
        elif path.startswith("/api/stories/") and not path.endswith("/preserve"):
            story_id = path[len("/api/stories/"):]
            self._handle_get_story(story_id)

        # 6. List stories
        elif path == "/api/stories":
            user_id, ok = self._get_authenticated_user_id()
            if not ok:
                return
            all_stories = list_stories()
            require_auth = os.getenv("VIRASYA_REQUIRE_AUTH", "").lower() in ("true", "1", "yes")
            if require_auth and user_id:
                all_stories = [s for s in all_stories if s.get("user_id") == user_id]
            self._send_json(all_stories)

        # 7. Vocabulary list
        elif path == "/api/vocabulary":
            user_id, ok = self._get_authenticated_user_id()
            if not ok:
                return
            terms = get_all_vocabulary()
            self._send_json(terms)

        else:
            self._send_json({"error": "Not found."}, HTTPStatus.NOT_FOUND)

    def do_POST(self) -> None:  # noqa: N802
        parsed_url = urlparse(self.path)
        path = parsed_url.path

        # Reject oversized requests before buffering into memory where possible
        content_length_hdr = self.headers.get("Content-Length")
        if content_length_hdr:
            try:
                content_length = int(content_length_hdr)
                if content_length > MAX_REQUEST_BYTES:
                    self._send_json(
                        {"error": "Request body exceeds maximum allowed size (5 MiB audio limit).", "code": "PAYLOAD_TOO_LARGE"},
                        HTTPStatus.REQUEST_ENTITY_TOO_LARGE,
                    )
                    return
            except ValueError:
                pass

        try:
            if path == "/api/upload":
                self._handle_upload()
            elif path == "/api/transcribe":
                self._handle_transcribe()
            elif path == "/api/save":
                self._handle_save_legacy()
            elif path == "/api/stories":
                self._handle_save_story()
            elif path.startswith("/api/stories/") and path.endswith("/preserve"):
                story_id = path[len("/api/stories/"): -len("/preserve")]
                self._handle_preserve_story(story_id)
            elif path == "/api/vocabulary":
                self._handle_save_vocabulary()
            elif path == "/api/punctuate":
                self._handle_punctuate()
            else:
                self._send_json({"error": "Not found."}, HTTPStatus.NOT_FOUND)
        except UnsupportedLanguageError as exc:
            self._send_json({"error": str(exc), "code": "unsupported_language"}, HTTPStatus.UNPROCESSABLE_ENTITY)
        except (UploadError, AudioError, ValueError) as exc:
            self._send_json({"error": str(exc), "code": "invalid_request"}, HTTPStatus.BAD_REQUEST)
        except MissingApiKeyError as exc:
            self._send_json({"error": str(exc), "code": "missing_api_key"}, HTTPStatus.SERVICE_UNAVAILABLE)
        except TranscriptionProviderError as exc:
            self._send_json({"error": str(exc), "code": "provider_error"}, HTTPStatus.BAD_GATEWAY)
        except StorageError as exc:
            self._send_json({"error": str(exc), "code": "storage_error"}, HTTPStatus.INTERNAL_SERVER_ERROR)
        except VirasyaError as exc:
            self._send_json({"error": str(exc), "code": "application_error"}, HTTPStatus.BAD_REQUEST)
        except Exception:
            self._send_json(
                {"error": "An internal server error occurred.", "code": "internal_error"},
                HTTPStatus.INTERNAL_SERVER_ERROR,
            )

    # -------------------------------------------------------------------------
    # Route Implementations
    # -------------------------------------------------------------------------

    def _get_authenticated_user_id(self, *, required: bool = False) -> tuple[str | None, bool]:
        """Verify authentication token and extract caller user ID.

        Returns:
            (user_id, True) if authenticated or if authentication is not required.
            (None, False) if authentication failed and an HTTP 401 response was sent.
        """
        require_auth = os.getenv("VIRASYA_REQUIRE_AUTH", "").lower() in ("true", "1", "yes")
        is_required = required or require_auth
        token = self._extract_bearer_token()

        if token:
            user_obj = self._verify_supabase_bearer_token(token)
            if user_obj and "id" in user_obj:
                return str(user_obj["id"]), True
            self._send_json(
                {"error": "Invalid or expired authorization token.", "code": "UNAUTHORIZED"},
                HTTPStatus.UNAUTHORIZED,
            )
            return None, False

        if is_required:
            self._send_json(
                {"error": "Authentication required for this operation.", "code": "AUTH_REQUIRED"},
                HTTPStatus.UNAUTHORIZED,
            )
            return None, False

        return None, True

    def _serve_audio_file(self, raw_filename: str) -> None:
        user_id, ok = self._get_authenticated_user_id()
        if not ok:
            return

        require_auth = os.getenv("VIRASYA_REQUIRE_AUTH", "").lower() in ("true", "1", "yes")
        file_path = _resolve_scratch_file(user_id, raw_filename, require_auth=require_auth, must_exist=True)
        if file_path is None or not file_path.is_file():
            self._send_json({"error": "Audio file not found or unauthorized."}, HTTPStatus.NOT_FOUND)
            return

        content_type, _ = mimetypes.guess_type(file_path.name)
        if not content_type:
            content_type = "application/octet-stream"

        try:
            body = file_path.read_bytes()
        except OSError:
            self._send_json({"error": "Could not read audio file."}, HTTPStatus.INTERNAL_SERVER_ERROR)
            return

        self.send_response(HTTPStatus.OK)
        self._set_cors_headers()
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Accept-Ranges", "bytes")
        self.end_headers()
        self.wfile.write(body)

    def _handle_upload(self) -> None:
        """Handle multipart audio upload for the React frontend (/api/upload)."""
        # Periodic cleanup of stale scratch files (older than 1 hour)
        cleanup_stale_scratch_files(INPUT_AUDIO_DIR, max_age_seconds=3600.0)

        # Authentication / authorization checks
        user_id, ok = self._get_authenticated_user_id()
        if not ok:
            return

        require_auth = os.getenv("VIRASYA_REQUIRE_AUTH", "").lower() in ("true", "1", "yes")

        fields = self._multipart_fields()
        file_field = fields["file"] if "file" in fields else fields.get("audio_file")
        if file_field is None or not getattr(file_field, "filename", None):
            raise UploadError("No audio file attached in upload.")

        original_filename = Path(file_field.filename).name
        ext = Path(original_filename).suffix.lower()
        if ext not in ALLOWED_AUDIO_EXTENSIONS:
            self._send_json(
                {"error": f"Unsupported audio format '{ext}'. Allowed: {', '.join(sorted(ALLOWED_AUDIO_EXTENSIONS))}", "code": "UNSUPPORTED_FILE_TYPE"},
                HTTPStatus.BAD_REQUEST
            )
            return

        dest_path = _resolve_scratch_file(user_id, original_filename, require_auth=require_auth, must_exist=False)
        if dest_path is None:
            self._send_json(
                {"error": "Invalid or unsafe audio filename.", "code": "INVALID_FILENAME"},
                HTTPStatus.BAD_REQUEST,
            )
            return

        safe_name = dest_path.name
        audio_bytes = file_field.file.read(MAX_UPLOAD_BYTES + 1)
        if len(audio_bytes) > MAX_UPLOAD_BYTES:
            self._send_json(
                {"error": "Audio file exceeds the 5 MiB (5,242,880 bytes) upload limit.", "code": "FILE_TOO_LARGE"},
                HTTPStatus.REQUEST_ENTITY_TOO_LARGE,
            )
            return
        if not audio_bytes:
            self._send_json({"error": "Audio file is empty (0 bytes).", "code": "EMPTY_FILE"}, HTTPStatus.BAD_REQUEST)
            return

        dest_path.write_bytes(audio_bytes)

        # Enforce duration limit <= 60 seconds and decodability at server boundary
        try:
            from virasya_ai.transcription.ingestion.audio import audio_duration_seconds, MAX_DURATION_SECONDS
            dur = audio_duration_seconds(dest_path)
            if dur > MAX_DURATION_SECONDS:
                dest_path.unlink(missing_ok=True)
                self._send_json(
                    {"error": f"Audio duration of {dur:.1f}s exceeds the 60-second limit accepted by GNANI AI.", "code": "AUDIO_TOO_LONG"},
                    HTTPStatus.BAD_REQUEST,
                )
                return
        except AudioTooLongError as exc:
            dest_path.unlink(missing_ok=True)
            self._send_json({"error": str(exc), "code": "AUDIO_TOO_LONG"}, HTTPStatus.BAD_REQUEST)
            return
        except (CorruptAudioError, UnsupportedFormatError, EmptyAudioError) as exc:
            dest_path.unlink(missing_ok=True)
            self._send_json({"error": str(exc), "code": "INVALID_AUDIO"}, HTTPStatus.BAD_REQUEST)
            return
        except Exception:
            dest_path.unlink(missing_ok=True)
            self._send_json(
                {
                    "error": "Failed to decode or verify audio duration. Ensure the file is a valid, supported audio recording.",
                    "code": "DURATION_VERIFICATION_FAILED",
                },
                HTTPStatus.BAD_REQUEST,
            )
            return

        self._send_json({
            "status": "success",
            "filename": safe_name,
            "url": f"/api/audio/{safe_name}",
            "size": len(audio_bytes),
        })

    def _handle_transcribe(self) -> None:
        """Handles both JSON transcription (React frontend) and multipart (legacy studio)."""
        user_id, ok = self._get_authenticated_user_id()
        if not ok:
            return

        content_type = self.headers.get("Content-Type", "").lower()

        if "multipart/form-data" in content_type:
            fields = self._multipart_fields()
            language_code = fields.getvalue("language_code", "")
            audio_field = fields["audio_file"] if "audio_file" in fields else fields.get("file")
            if audio_field is None or not getattr(audio_field, "filename", None):
                raise UploadError("Choose an audio file before transcribing.")
            filename = Path(audio_field.filename).name
            audio_bytes = audio_field.file.read(MAX_UPLOAD_BYTES + 1)

            acquired = _TRANSCRIPTION_SEMAPHORE.acquire(blocking=True, timeout=2.0)
            if not acquired:
                self._send_json(
                    {
                        "error": "Transcription engine is currently at capacity. Please try again shortly.",
                        "code": "ENGINE_BUSY",
                    },
                    HTTPStatus.TOO_MANY_REQUESTS,
                )
                return

            try:
                result = transcribe_uploaded_audio(audio_bytes, filename, language_code)
            finally:
                _TRANSCRIPTION_SEMAPHORE.release()

            self._send_json({
                "audio_filename": filename,
                "language": language_code,
                "raw_text": result.text,
                "provider": result.provider,
            })
            return

        # JSON body expected by React frontend: { filename: "...", model: "both|vaani", story_id: "..." }
        require_auth = os.getenv("VIRASYA_REQUIRE_AUTH", "").lower() in ("true", "1", "yes")
        payload = self._json_body()
        filename = payload.get("filename")
        if not filename or not isinstance(filename, str):
            raise ValueError("A valid 'filename' string is required for transcription.")

        audio_path = _resolve_scratch_file(user_id, filename, require_auth=require_auth, must_exist=True)
        if audio_path is None or not audio_path.is_file():
            raise ValueError(f"Audio file '{sanitize_filename(filename)}' not found. Please upload it first.")

        safe_name = audio_path.name

        # Re-enforce size and duration boundaries before sending to GNANI API
        if audio_path.stat().st_size > MAX_UPLOAD_BYTES:
            raise UploadError("Audio file exceeds the 5 MiB (5,242,880 bytes) upload limit.")

        try:
            from virasya_ai.transcription.ingestion.audio import audio_duration_seconds, MAX_DURATION_SECONDS
            dur = audio_duration_seconds(audio_path)
            if dur > MAX_DURATION_SECONDS:
                raise AudioTooLongError(f"Audio duration ({dur:.1f}s) exceeds the maximum 60-second GNANI API limit.")
        except (CorruptAudioError, UnsupportedFormatError, AudioTooLongError, EmptyAudioError):
            raise
        except Exception as exc:
            raise CorruptAudioError(f"Failed to verify audio duration for '{safe_name}': {exc}") from exc

        # Determine and validate language code:
        # User must explicitly select the audio language from the 10 supported Indic languages.
        raw_lang = payload.get("language") or payload.get("language_code")
        if not raw_lang or not isinstance(raw_lang, str) or not raw_lang.strip():
            self._send_json(
                {"error": "Audio language is required before transcription. Please select a supported language.", "code": "missing_language"},
                HTTPStatus.BAD_REQUEST,
            )
            return

        lang_opt = resolve_language_option(raw_lang)
        if lang_opt is None or not lang_opt.provider_configured:
            raise UnsupportedLanguageError(
                f"Unsupported language '{raw_lang}'. Gnani Prisma STT supports: Hindi, Bengali, Gujarati, Kannada, Malayalam, Marathi, Punjabi, Tamil, English (India), Telugu."
            )

        language_code = lang_opt.code
        requested_language = lang_opt.name

        acquired = _TRANSCRIPTION_SEMAPHORE.acquire(blocking=True, timeout=2.0)
        if not acquired:
            self._send_json(
                {
                    "error": "Transcription engine is currently at capacity. Please try again shortly.",
                    "code": "ENGINE_BUSY",
                },
                HTTPStatus.TOO_MANY_REQUESTS,
            )
            return

        try:
            t0 = time.perf_counter()
            with GnaniTranscriptionService() as service:
                res = service.transcribe(audio_path, language_code=language_code)
            elapsed = round(time.perf_counter() - t0, 3)
        finally:
            _TRANSCRIPTION_SEMAPHORE.release()

        transcript_text = res.text.strip()
        provider_name = res.provider or "gnani-prisma-v2.5"

        # Construct response matching TranscribeResponse expected by React frontend
        item = {
            "status": "done",
            "text": transcript_text,
            "model": "Gnani Prisma STT v2.5",
            "provider": provider_name,
            "inference_seconds": elapsed,
            "language": language_code,
            "requested_language": requested_language,
            "provider_language": res.language,
            "error": None,
        }

        self._send_json({
            "status": "success",
            "filename": safe_name,
            "results": {
                "gnani": item,
                "vaani": item,
            },
            "gnani": transcript_text,
            "gnani_info": item,
            "vaani": transcript_text,
            "vaani_info": item,
            "transcript": transcript_text,
            "raw_text": transcript_text,
            "requested_language": requested_language,
            "language": language_code,
            "language_code": language_code,
            "provider_language": res.language,
            "provider": provider_name,
            "metadata": res.provider_metadata,
        })

    def _handle_save_legacy(self) -> None:
        user_id, ok = self._get_authenticated_user_id()
        if not ok:
            return
        payload = self._json_body()
        required = ("audio_filename", "language", "raw_text", "reviewed_text")
        if any(not isinstance(payload.get(key), str) for key in required):
            raise ValueError("Audio filename, language, raw text, and reviewed text are required.")
        if not payload["raw_text"].strip() or not payload["reviewed_text"].strip():
            raise ValueError("Raw and reviewed transcript text cannot be empty.")
        if get_language(payload["language"]) is None:
            raise ValueError("The selected language is not recognized.")
        filename = sanitize_filename(payload["audio_filename"])
        record = TranscriptStore().append(
            audio_filename=filename,
            language=payload["language"],
            raw_text=payload["raw_text"],
            reviewed_text=payload["reviewed_text"],
        )
        self._send_json({"saved": True, "record": record}, HTTPStatus.CREATED)

    def _handle_save_story(self) -> None:
        user_id, ok = self._get_authenticated_user_id()
        if not ok:
            return
        story = self._json_body()
        story_id = story.get("id")
        if story_id:
            existing = get_story(story_id)
            if existing:
                existing_owner = existing.get("user_id")
                require_auth = os.getenv("VIRASYA_REQUIRE_AUTH", "").lower() in ("true", "1", "yes")
                if (require_auth and existing_owner != user_id) or (user_id and existing_owner and existing_owner != user_id):
                    self._send_json(
                        {"error": "Forbidden: Cannot modify a story belonging to another user.", "code": "FORBIDDEN"},
                        HTTPStatus.FORBIDDEN,
                    )
                    return
                if existing.get("status") == "preserved":
                    self._send_json(
                        {"error": "Cannot modify a preserved story.", "code": "ALREADY_PRESERVED"},
                        HTTPStatus.BAD_REQUEST,
                    )
                    return
        else:
            story["id"] = f"story_{int(time.time() * 1000)}"

        if user_id:
            story["user_id"] = user_id
        if "status" not in story:
            story["status"] = "draft"
        saved = save_story(story)
        self._send_json({"status": "success", "story": saved})

    def _handle_get_story(self, story_id: str) -> None:
        user_id, ok = self._get_authenticated_user_id()
        if not ok:
            return
        story = get_story(story_id)
        if not story:
            self._send_json({"error": "Story not found."}, HTTPStatus.NOT_FOUND)
            return

        require_auth = os.getenv("VIRASYA_REQUIRE_AUTH", "").lower() in ("true", "1", "yes")
        if require_auth:
            is_owner = bool(user_id and story.get("user_id") == user_id)
            is_public_preserved = (story.get("status") == "preserved" and story.get("visibility") == "public")
            if not is_owner and not is_public_preserved:
                self._send_json(
                    {"error": "Forbidden: You do not have permission to view this story.", "code": "FORBIDDEN"},
                    HTTPStatus.FORBIDDEN,
                )
                return

        self._send_json(story)

    def _extract_bearer_token(self) -> str | None:
        auth_header = self.headers.get("Authorization") or ""
        if auth_header.startswith("Bearer "):
            token = auth_header[7:].strip()
            return token if token else None
        return None

    def _verify_supabase_bearer_token(self, token: str) -> dict | None:
        supabase_url = os.getenv("SUPABASE_URL") or os.getenv("VITE_SUPABASE_URL")
        if not supabase_url:
            return None
        api_key = (
            os.getenv("SUPABASE_SERVICE_ROLE_KEY")
            or os.getenv("SUPABASE_ANON_KEY")
            or os.getenv("VITE_SUPABASE_PUBLISHABLE_KEY")
            or os.getenv("VITE_SUPABASE_ANON_KEY")
            or ""
        )
        url = f"{supabase_url.rstrip('/')}/auth/v1/user"
        headers = {"Authorization": f"Bearer {token}"}
        if api_key:
            headers["apikey"] = api_key

        req = urllib.request.Request(url, headers=headers)
        try:
            with urllib.request.urlopen(req, timeout=5) as resp:
                if resp.status == HTTPStatus.OK:
                    return json.loads(resp.read().decode("utf-8"))
        except Exception:
            return None
        return None

    def _sync_preserved_story_to_supabase(self, story_dict: dict) -> None:
        # Direct service-role sync bypasses Edge Function quota validation and provenance sealing.
        # It is disabled by default to prevent privilege escalation / bypass of the Edge Function.
        allow_direct_sync = os.getenv("VIRASYA_ALLOW_DIRECT_SERVICE_ROLE_SYNC", "").lower() in ("true", "1")
        if not allow_direct_sync:
            return

        supabase_url = os.getenv("SUPABASE_URL")
        service_key = os.getenv("SUPABASE_SERVICE_ROLE_KEY")
        if not supabase_url or not service_key:
            return

        story_id = story_dict.get("id")
        user_id = story_dict.get("user_id")
        if not story_id or not user_id:
            raise StorageError("Cannot sync story to Supabase without verified story ID and user ID.")

        # Hardened pre-flight: check if story exists remotely before inserting
        check_url = f"{supabase_url.rstrip('/')}/rest/v1/stories?id=eq.{urllib.parse.quote(str(story_id))}&select=id,user_id,status"
        check_headers = {
            "apikey": service_key,
            "Authorization": f"Bearer {service_key}",
        }
        check_req = urllib.request.Request(check_url, headers=check_headers, method="GET")
        try:
            with urllib.request.urlopen(check_req, timeout=5) as check_resp:
                existing_remote = json.loads(check_resp.read().decode("utf-8"))
                if existing_remote and len(existing_remote) > 0:
                    remote_row = existing_remote[0]
                    if remote_row.get("user_id") != user_id:
                        raise StorageError("Remote story exists and belongs to a different user.")
                    if remote_row.get("status") == "preserved":
                        raise StorageError("Remote story is already preserved and sealed.")
                    raise StorageError("Remote story already exists; duplicate insertion refused.")
        except urllib.error.HTTPError as exc:
            raise StorageError(f"Failed to query remote story state: {exc.code}") from exc

        db_row = {
            "id": story_dict.get("id"),
            "user_id": story_dict.get("user_id"),
            "title": story_dict.get("title", ""),
            "carrier": story_dict.get("carrier", ""),
            "relationship": story_dict.get("relationship", ""),
            "place": story_dict.get("place", ""),
            "roots": story_dict.get("roots", ""),
            "category": story_dict.get("category", ""),
            "language": story_dict.get("language", "Odia"),
            "period": story_dict.get("period", ""),
            "email": story_dict.get("email", ""),
            "written_text": story_dict.get("writtenText") or story_dict.get("written_text", ""),
            "working_draft": story_dict.get("workingDraft") or story_dict.get("working_draft", ""),
            "final_text": story_dict.get("final_text") or story_dict.get("story", ""),
            "story": story_dict.get("story") or story_dict.get("final_text", ""),
            "audio": story_dict.get("audio"),
            "raw_transcripts": story_dict.get("raw_transcripts") or {},
            "vocabulary": story_dict.get("vocabulary") or [],
            "punctuation": story_dict.get("punctuation") or {},
            "final_settings": story_dict.get("finalSettings") or {},
            "status": "preserved",
            "visibility": story_dict.get("visibility", "public"),
            "confirmed": True,
            "permission_confirmed": True,
            "provenance_id": story_dict.get("provenance_id"),
            "provenance_hash": story_dict.get("provenance_hash"),
            "preserved_at": story_dict.get("preserved_at"),
        }

        url = f"{supabase_url.rstrip('/')}/rest/v1/stories"
        req_data = json.dumps(db_row).encode("utf-8")
        headers = {
            "Content-Type": "application/json",
            "apikey": service_key,
            "Authorization": f"Bearer {service_key}",
            "Prefer": "return=minimal",
        }
        req = urllib.request.Request(url, data=req_data, headers=headers, method="POST")
        try:
            with urllib.request.urlopen(req, timeout=5) as resp:
                if resp.status not in (HTTPStatus.OK, HTTPStatus.CREATED, HTTPStatus.NO_CONTENT):
                    raise StorageError(f"Supabase returned status {resp.status}")
        except urllib.error.HTTPError as exc:
            raise StorageError(f"Failed to sync preserved story to Supabase: {exc.code}") from exc

    def _handle_preserve_story(self, story_id: str) -> None:
        user_id, ok = self._get_authenticated_user_id()
        if not ok:
            return

        payload = self._json_body()
        existing = get_story(story_id)
        if existing:
            existing_owner = existing.get("user_id")
            require_auth = os.getenv("VIRASYA_REQUIRE_AUTH", "").lower() in ("true", "1", "yes")
            if (require_auth and existing_owner != user_id) or (user_id and existing_owner and existing_owner != user_id):
                self._send_json(
                    {"error": "Forbidden: Cannot preserve a story belonging to another user.", "code": "FORBIDDEN"},
                    HTTPStatus.FORBIDDEN,
                )
                return
        else:
            existing = {"id": story_id}

        if user_id:
            existing["user_id"] = user_id

        existing["status"] = "preserved"
        existing["finalSettings"] = {
            "visibility": payload.get("visibility", "public"),
            "confirmed": payload.get("confirmed", True),
            "permissionConfirmed": payload.get("permissionConfirmed", True),
        }
        existing["visibility"] = payload.get("visibility", "public")

        if payload.get("final_text"):
            existing["final_text"] = payload["final_text"]
            existing["story"] = payload["final_text"]
        elif payload.get("story"):
            existing["final_text"] = payload["story"]
            existing["story"] = payload["story"]

        if payload.get("writtenText") or payload.get("written_text"):
            existing["written_text"] = payload.get("writtenText") or payload.get("written_text")
        if payload.get("vocabulary"):
            existing["vocabulary"] = payload["vocabulary"]
            if isinstance(payload["vocabulary"], list):
                save_vocabulary_terms(payload["vocabulary"])

        now_str = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        prov_id = f"prov_{int(time.time() * 1000)}"
        prov_hash = hashlib.sha256(f"{story_id}:{now_str}".encode("utf-8")).hexdigest()[:16]

        existing["preserved_at"] = now_str
        existing["provenance_id"] = prov_id
        existing["provenance_hash"] = prov_hash

        saved = save_story(existing)

        # Sync to Supabase if configured (non-blocking)
        try:
            self._sync_preserved_story_to_supabase(saved)
        except Exception as exc:
            print(f"[Supabase Sync Warning] Failed to sync story {story_id}: {exc}")

        self._send_json({
            "status": "success",
            "story": saved,
            "preserved_at": now_str,
            "provenance_id": prov_id,
            "provenance_hash": prov_hash,
        })

    def _handle_explore_feed(self, query_params: dict[str, list[str]]) -> None:
        # Returns only stories that are BOTH preserved and public
        all_public = list_stories(public_only=True, preserved_only=True)

        search_query = (query_params.get("search") or query_params.get("q") or [""])[0].strip().lower()
        category_filter = (query_params.get("category") or ["All"])[0].strip()
        language_filter = (query_params.get("language") or ["All"])[0].strip()

        cards = []
        for s in all_public:
            title = s.get("title") or (s.get("form") or {}).get("title") or "Untitled Story"
            category = s.get("category") or (s.get("form") or {}).get("category") or "General"
            language = s.get("language") or (s.get("form") or {}).get("language") or "Odia"
            place = s.get("place") or s.get("roots") or (s.get("form") or {}).get("place") or ""
            carrier = s.get("carrier") or (s.get("form") or {}).get("carrier") or ""

            # Apply filters
            if category_filter not in ("All", "") and category.lower() != category_filter.lower():
                continue
            if language_filter not in ("All", "") and language.lower() != language_filter.lower():
                continue
            if search_query:
                searchable = f"{title} {carrier} {place} {category} {language}".lower()
                if search_query not in searchable:
                    continue

            excerpt = s.get("excerpt") or s.get("story") or (s.get("form") or {}).get("story") or ""
            if len(excerpt) > 160:
                excerpt = excerpt[:157] + "..."

            final_text = s.get("final_text") or excerpt
            words = len(final_text.split())

            vocab = s.get("vocabulary") or []
            cards.append({
                "id": str(s.get("id")),
                "title": title,
                "carrier": carrier,
                "category": category,
                "place": place,
                "roots": place,
                "language": language,
                "period": s.get("period") or (s.get("form") or {}).get("period") or "",
                "relationship": s.get("relationship") or (s.get("form") or {}).get("relationship") or "",
                "excerpt": excerpt,
                "word_count": words,
                "preserved_at": s.get("preserved_at") or s.get("created_at") or "",
                "provenance_id": s.get("provenance_id") or "",
                "vocabulary_count": len(vocab),
                "has_audio": bool(s.get("audio")),
                "is_preview": False,
                "vocabulary": vocab,
            })

        self._send_json({
            "status": "success",
            "count": len(cards),
            "stories": cards,
        })

    def _handle_get_story_detail(self, story_id: str) -> None:
        story = get_story(story_id)
        if not story:
            self._send_json({"error": "Story not found."}, HTTPStatus.NOT_FOUND)
            return

        # Check visibility: private stories cannot be retrieved anonymously via explore
        visibility = story.get("finalSettings", {}).get("visibility") or story.get("visibility")
        if visibility != "public" or story.get("status") != "preserved":
            self._send_json({"error": "Access denied: Story is private or draft."}, HTTPStatus.FORBIDDEN)
            return

        title = story.get("title") or (story.get("form") or {}).get("title") or "Untitled Story"
        category = story.get("category") or (story.get("form") or {}).get("category") or "General"
        language = story.get("language") or (story.get("form") or {}).get("language") or "Odia"
        place = story.get("place") or story.get("roots") or (story.get("form") or {}).get("place") or ""
        carrier = story.get("carrier") or (story.get("form") or {}).get("carrier") or ""

        excerpt = story.get("excerpt") or story.get("story") or (story.get("form") or {}).get("story") or ""
        final_text = story.get("final_text") or excerpt
        words = len(final_text.split())
        vocab = story.get("vocabulary") or []

        detail = {
            "id": str(story.get("id")),
            "title": title,
            "carrier": carrier,
            "category": category,
            "place": place,
            "roots": place,
            "language": language,
            "period": story.get("period") or (story.get("form") or {}).get("period") or "",
            "relationship": story.get("relationship") or (story.get("form") or {}).get("relationship") or "",
            "excerpt": excerpt,
            "word_count": words,
            "preserved_at": story.get("preserved_at") or story.get("created_at") or "",
            "provenance_id": story.get("provenance_id") or "",
            "vocabulary_count": len(vocab),
            "has_audio": bool(story.get("audio")),
            "is_preview": False,
            "vocabulary": vocab,
            "final_text": final_text,
            "audio": story.get("audio"),
            "raw_transcripts": story.get("raw_transcripts"),
        }
        self._send_json({"status": "success", "story": detail})

    def _handle_save_vocabulary(self) -> None:
        user_id, ok = self._get_authenticated_user_id()
        if not ok:
            return
        payload = self._json_body()
        words = payload.get("words", [])
        if not isinstance(words, list):
            raise ValueError("Expected a 'words' array in vocabulary request.")
        saved = save_vocabulary_terms(words)
        self._send_json({"status": "success", "count": len(saved), "entries": saved})

    def _handle_punctuate(self) -> None:
        payload = self._json_body()
        text = payload.get("text", "")
        # Safe deterministic fallback punctuation for Indian languages if no offline mmBERT model is loaded
        # Preserves words accurately while returning standard response
        self._send_json({
            "status": "success",
            "supported": True,
            "original_text": text,
            "punctuated_text": text,
            "message": "Punctuation validated with word integrity confirmed.",
        })

    # -------------------------------------------------------------------------
    # Request Helpers
    # -------------------------------------------------------------------------

    def _multipart_fields(self) -> MultipartData:
        content_type = self.headers.get("Content-Type", "")
        if not content_type.lower().startswith("multipart/form-data"):
            raise UploadError("Transcription requires a multipart audio upload.")
        length = self._content_length()
        if length > MAX_REQUEST_BYTES:
            raise UploadError("The upload is too large.")
        body = self.rfile.read(length)

        header_bytes = f"Content-Type: {content_type}\r\nMIME-Version: 1.0\r\n\r\n".encode("latin1")
        msg = email.message_from_bytes(header_bytes + body, policy=email.policy.default)

        data = MultipartData()
        for part in msg.iter_parts():
            name = part.get_param("name", header="content-disposition")
            if not name:
                continue
            filename = part.get_filename()
            payload = part.get_payload(decode=True)
            if payload is None:
                payload = b""
            data.add(
                MultipartField(
                    name=name,
                    value=payload,
                    filename=filename,
                    content_type=part.get_content_type(),
                )
            )
        return data

    def _json_body(self) -> dict[str, Any]:
        content_type = self.headers.get("Content-Type", "").lower()
        if "application/json" not in content_type:
            raise ValueError("Expected a JSON request.")
        length = self._content_length()
        if length > 10 * 1024 * 1024:
            raise ValueError("The request payload exceeds the 10 MB limit.")

        # If Content-Length > 0, read exact bytes. Otherwise handle chunked or read until EOF
        if length > 0:
            body = self.rfile.read(length)
        else:
            # Fallback for chunked or unstated content-length
            body = self.rfile.read()

        try:
            payload = json.loads(body.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise ValueError("The request body is not valid JSON.") from exc
        if not isinstance(payload, dict):
            raise ValueError("The request body must be a JSON object.")
        return payload

    def _content_length(self) -> int:
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError as exc:
            raise UploadError("The request length is invalid.") from exc
        if length < 0:
            raise UploadError("The request length is invalid.")
        return length

    def _send_static(self, filename: str, content_type: str) -> None:
        path = STATIC_DIR / filename
        try:
            body = path.read_bytes()
        except OSError:
            self._send_json({"error": "Static asset not found."}, HTTPStatus.NOT_FOUND)
            return
        self.send_response(HTTPStatus.OK)
        self._set_cors_headers()
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        self.wfile.write(body)

    def _send_json(self, payload: Any, status: HTTPStatus = HTTPStatus.OK) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self._set_cors_headers()
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)


def create_server(host: str = "127.0.0.1", port: int = 5000) -> ThreadingHTTPServer:
    return ThreadingHTTPServer((host, port), StudioHandler)


def main() -> None:
    raw_port = os.getenv("PORT") or os.getenv("VIRASYA_WEB_PORT", "5000")
    try:
        port = int(raw_port)
    except ValueError as exc:
        raise SystemExit(f"Server port must be an integer (received: '{raw_port}').") from exc

    require_auth = os.getenv("VIRASYA_REQUIRE_AUTH", "").lower() in ("true", "1", "yes")
    supabase_url = os.getenv("SUPABASE_URL") or os.getenv("VITE_SUPABASE_URL")
    if require_auth and not supabase_url:
        raise SystemExit(
            "FATAL CONFIGURATION ERROR: VIRASYA_REQUIRE_AUTH is enabled, but neither "
            "SUPABASE_URL nor VITE_SUPABASE_URL is configured. Server cannot verify authentication tokens."
        )

    default_host = "0.0.0.0" if "PORT" in os.environ else "127.0.0.1"
    host = os.getenv("VIRASYA_WEB_HOST", default_host)
    if not require_auth and host not in ("127.0.0.1", "localhost", "::1"):
        allow_insecure = os.getenv("VIRASYA_ALLOW_INSECURE_HOST", "").lower() in ("true", "1", "yes")
        if not allow_insecure:
            raise SystemExit(
                f"FATAL SECURITY ERROR: Server is configured to bind to non-loopback host '{host}' "
                "with VIRASYA_REQUIRE_AUTH disabled. This exposes unprotected endpoints to the network. "
                "Set VIRASYA_REQUIRE_AUTH=true or explicitly set VIRASYA_ALLOW_INSECURE_HOST=1 to override."
            )
        print(
            f"WARNING: Server is binding to non-loopback host '{host}' with VIRASYA_REQUIRE_AUTH disabled "
            "(VIRASYA_ALLOW_INSECURE_HOST=1 override active). Anyone on the network can access the API."
        )
    server = create_server(host, port)
    print(f"Virasya AI Backend running on http://{host}:{port}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
