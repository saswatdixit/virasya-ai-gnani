/**
 * Virasya Audio Limits & Supported Formats Constants
 *
 * Requirements:
 * - Maximum audio duration: 30 seconds (strictly matching GNANI API limits)
 * - Maximum audio file size: 5 MiB (5 * 1024 * 1024 bytes = 5,242,880 bytes)
 * - Supported audio formats allowlist: WAV, OGG, MP3, M4A, FLAC, AAC, WebM
 */

export const MAX_AUDIO_DURATION_SECONDS = 30;
export const MAX_AUDIO_SIZE_BYTES = 5 * 1024 * 1024; // 5 MiB (5,242,880 bytes)
export const MAX_AUDIO_SIZE_MIB = 5;

export const ALLOWED_AUDIO_EXTENSIONS = [
  ".wav",
  ".ogg",
  ".mp3",
  ".m4a",
  ".flac",
  ".aac",
  ".webm",
] as const;

export const ALLOWED_AUDIO_MIME_TYPES = [
  "audio/wav",
  "audio/x-wav",
  "audio/wave",
  "audio/ogg",
  "audio/vorbis",
  "audio/opus",
  "audio/mpeg",
  "audio/mp3",
  "audio/mp4",
  "audio/x-m4a",
  "audio/m4a",
  "audio/aac",
  "audio/flac",
  "audio/x-flac",
  "audio/webm",
] as const;

export const AUDIO_STORAGE_BUCKET = "story-recordings-private";
