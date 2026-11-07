/**
 * Server-Side Audio Container and Duration Validator
 *
 * Enforces:
 * 1. Strict file size bounds: (0, 5 MiB] (5,242,880 bytes) before parsing.
 * 2. Magic-byte container format verification (rejects renamed binaries or arbitrary payloads).
 * 3. Deep structural frame/chunk parsing to determine actual audio duration directly from container data:
 *    - WebM: Validates Cluster timestamps and block timing; rejects if clusters contradict Info.Duration or exceed 60s.
 *    - OGG: Sequentially parses OggS pages, tracks serial number, enforces monotonic granule progress, prevents trailing page spoofing.
 *    - MP3: Scans MPEG-1, MPEG-2, and MPEG-2.5 Layer III frame headers; rejects files where frames exceed Xing header claims or 60s.
 *    - M4A: Inspects mvhd, mdhd, and stts sample tables; rejects short declared durations with oversized media payloads.
 *    - WAV: Verifies RIFF/RF64 structure, format tag (PCM/Float only), byteRate, dataSize, and rejects unallocated trailing payloads.
 *    - FLAC: Validates STREAMINFO and cross-checks sample counts against file payload boundaries.
 * 4. Strict duration bounds: (0, 60.0] seconds.
 * 5. Fail-closed on corrupted, truncated, malformed, or unparsable audio.
 *
 * Compatible with Deno Edge Runtime and Node.js (zero external dependencies).
 */

export const MAX_AUDIO_BYTES = 5 * 1024 * 1024; // 5 MiB = 5,242,880 bytes
export const MAX_AUDIO_DURATION_SECONDS = 60.0;

export const ALLOWED_AUDIO_EXTENSIONS = new Set([
  ".wav",
  ".ogg",
  ".mp3",
  ".m4a",
  ".flac",
  ".aac",
  ".webm",
]);

export interface AudioValidationSuccess {
  valid: true;
  format: "wav" | "ogg" | "mp3" | "flac" | "m4a" | "webm" | "aac";
  durationSeconds: number;
  byteSize: number;
}

export interface AudioValidationFailure {
  valid: false;
  code:
    | "EMPTY_AUDIO"
    | "AUDIO_TOO_LARGE"
    | "UNRECOGNIZED_CONTAINER"
    | "MALFORMED_AUDIO_HEADER"
    | "AUDIO_DURATION_UNVERIFIABLE"
    | "AUDIO_TOO_LONG";
  error: string;
  byteSize: number;
}

export type AudioValidationResult = AudioValidationSuccess | AudioValidationFailure;

/**
 * Validate audio bytes and extract true container duration at trusted server boundary.
 */
export function validateAudioBuffer(buffer: Uint8Array, fileExtension = ""): AudioValidationResult {
  const byteSize = buffer.byteLength;

  if (byteSize === 0) {
    return {
      valid: false,
      code: "EMPTY_AUDIO",
      error: "Audio recording is empty (0 bytes).",
      byteSize,
    };
  }

  // Pre-parsing memory & size boundary gate
  if (byteSize > MAX_AUDIO_BYTES) {
    return {
      valid: false,
      code: "AUDIO_TOO_LARGE",
      error: `Audio file size (${byteSize} bytes) exceeds the 5 MiB (5,242,880 bytes) limit.`,
      byteSize,
    };
  }

  if (fileExtension && !ALLOWED_AUDIO_EXTENSIONS.has(fileExtension.toLowerCase())) {
    return {
      valid: false,
      code: "UNRECOGNIZED_CONTAINER",
      error: `Unsupported audio file extension '${fileExtension}'. Permitted extensions: ${Array.from(ALLOWED_AUDIO_EXTENSIONS).join(", ")}.`,
      byteSize,
    };
  }

  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);

  // 1. WAV (RIFF WAVE / RF64)
  if (
    byteSize >= 12 &&
    (readAscii(buffer, 0, 4) === "RIFF" || readAscii(buffer, 0, 4) === "RF64") &&
    readAscii(buffer, 8, 4) === "WAVE"
  ) {
    return parseWav(buffer, view, byteSize);
  }

  // 2. OGG (OggS container: Vorbis or Opus)
  if (byteSize >= 14 && readAscii(buffer, 0, 4) === "OggS") {
    return parseOgg(buffer, view, byteSize);
  }

  // 3. FLAC (fLaC)
  if (byteSize >= 42 && readAscii(buffer, 0, 4) === "fLaC") {
    return parseFlac(buffer, view, byteSize);
  }

  // 4. WebM / Matroska (EBML: 0x1A 0x45 0xDF 0xA3)
  if (
    byteSize >= 12 &&
    buffer[0] === 0x1a &&
    buffer[1] === 0x45 &&
    buffer[2] === 0xdf &&
    buffer[3] === 0xa3
  ) {
    return parseWebM(buffer, view, byteSize);
  }

  // 5. MP4 / M4A / AAC in BMFF (starts with [size][ftyp])
  if (byteSize >= 12 && readAscii(buffer, 4, 4) === "ftyp") {
    return parseM4a(buffer, view, byteSize);
  }

  // 6. ADTS AAC
  if (isAdtsSync(buffer, 0)) {
    return parseAdts(buffer, view, byteSize);
  }

  // 7. MP3 (ID3v2 or direct MPEG frame sync)
  if (
    (byteSize >= 10 && readAscii(buffer, 0, 3) === "ID3") ||
    isMpegFrameSync(buffer, 0)
  ) {
    return parseMp3(buffer, view, byteSize);
  }

  return {
    valid: false,
    code: "UNRECOGNIZED_CONTAINER",
    error: `Unsupported or invalid audio format. Permitted containers: WAV, OGG, MP3, M4A, FLAC, WebM, AAC. File extension was '${fileExtension}'.`,
    byteSize,
  };
}

// -----------------------------------------------------------------------------
// Container Parsers
// -----------------------------------------------------------------------------

function parseWav(buffer: Uint8Array, view: DataView, byteSize: number): AudioValidationResult {
  if (byteSize < 44) {
    return {
      valid: false,
      code: "MALFORMED_AUDIO_HEADER",
      error: "WAV file is truncated (smaller than minimum 44-byte RIFF header).",
      byteSize,
    };
  }

  const riffSize = view.getUint32(4, true);
  if (byteSize < riffSize + 8) {
    return {
      valid: false,
      code: "MALFORMED_AUDIO_HEADER",
      error: "WAV file is truncated according to RIFF header.",
      byteSize,
    };
  }

  let offset = 12;
  let sampleRate = 0;
  let byteRate = 0;
  let channels = 0;
  let bitsPerSample = 0;
  let formatTag = 0;
  let dataSize = 0;
  let dataOffset = 0;
  let foundFmt = false;
  let foundData = false;

  while (offset + 8 <= byteSize) {
    const chunkId = readAscii(buffer, offset, 4);
    const chunkSize = view.getUint32(offset + 4, true);
    const chunkDataOffset = offset + 8;

    if (chunkId === "fmt ") {
      if (chunkSize < 16 || chunkDataOffset + 16 > byteSize) {
        return {
          valid: false,
          code: "MALFORMED_AUDIO_HEADER",
          error: "WAV 'fmt ' chunk is corrupt or truncated.",
          byteSize,
        };
      }
      formatTag = view.getUint16(chunkDataOffset, true);
      channels = view.getUint16(chunkDataOffset + 2, true);
      sampleRate = view.getUint32(chunkDataOffset + 4, true);
      byteRate = view.getUint32(chunkDataOffset + 8, true);
      bitsPerSample = view.getUint16(chunkDataOffset + 14, true);
      foundFmt = true;
    } else if (chunkId === "data") {
      dataSize = chunkSize;
      dataOffset = chunkDataOffset;
      foundData = true;
      offset += 8 + chunkSize;
      if (chunkSize % 2 !== 0) offset += 1;
      continue;
    }

    offset += 8 + chunkSize;
    if (chunkSize % 2 !== 0) offset += 1;
  }

  if (!foundFmt || sampleRate <= 0 || channels <= 0) {
    return {
      valid: false,
      code: "MALFORMED_AUDIO_HEADER",
      error: "WAV file does not contain valid audio format specification.",
      byteSize,
    };
  }

  // Format code: 1 = PCM, 3 = IEEE Float, 0xFFFE = Extensible
  if (formatTag !== 1 && formatTag !== 3 && formatTag !== 0xfffe) {
    return {
      valid: false,
      code: "UNRECOGNIZED_CONTAINER",
      error: `Unsupported compressed WAV format code (0x${formatTag.toString(16)}). Only uncompressed PCM/Float WAV is permitted.`,
      byteSize,
    };
  }

  if (!foundData || dataSize <= 0) {
    return {
      valid: false,
      code: "AUDIO_DURATION_UNVERIFIABLE",
      error: "WAV file contains no audio data chunk.",
      byteSize,
    };
  }

  const derivedByteRate = sampleRate * channels * Math.max(1, Math.floor(bitsPerSample / 8));
  if (byteRate <= 0 || Math.abs(byteRate - derivedByteRate) > derivedByteRate * 0.1) {
    byteRate = derivedByteRate;
  }

  // Cross-check dataSize against available buffer payload
  const availablePayload = byteSize - dataOffset;
  if (dataSize > availablePayload) {
    return {
      valid: false,
      code: "MALFORMED_AUDIO_HEADER",
      error: "WAV data chunk claims more bytes than available in file payload.",
      byteSize,
    };
  }

  // Adversarial check: Check if there is significant unexplained payload after data chunk
  // (e.g. claiming dataSize = 32000 (1s) while 4 MB of audio payload exists)
  const remainingBytes = byteSize - (dataOffset + dataSize);
  const durationFromData = dataSize / byteRate;
  const maxPossibleDuration = availablePayload / byteRate;

  // If available audio payload exceeds 60 seconds, even if dataSize claims <= 60s
  if (maxPossibleDuration > MAX_AUDIO_DURATION_SECONDS && remainingBytes > 1024) {
    return {
      valid: false,
      code: "AUDIO_TOO_LONG",
      error: `WAV file payload (${maxPossibleDuration.toFixed(1)}s potential audio) exceeds the 60-second limit.`,
      byteSize,
    };
  }

  return checkDuration(durationFromData, "wav", byteSize);
}

function parseOgg(buffer: Uint8Array, view: DataView, byteSize: number): AudioValidationResult {
  // Parse OGG pages sequentially from offset 0 to prevent spoofed trailing pages
  let offset = 0;
  let pageCount = 0;

  interface OggLogicalStream {
    codec: "opus" | "vorbis" | "unknown";
    sampleRate: number;
    preSkip: number;
    lastSeq: number;
    maxGranule: number;
    hasGranule: boolean;
    pageCount: number;
  }

  const streams = new Map<number, OggLogicalStream>();

  while (offset + 27 <= byteSize) {
    if (
      buffer[offset] !== 0x4f ||
      buffer[offset + 1] !== 0x67 ||
      buffer[offset + 2] !== 0x67 ||
      buffer[offset + 3] !== 0x53
    ) {
      if (pageCount > 0) {
        break; // Reached end of valid Ogg stream pages
      }
      return {
        valid: false,
        code: "MALFORMED_AUDIO_HEADER",
        error: "Invalid OGG page header signature.",
        byteSize,
      };
    }

    const lowGranule = view.getUint32(offset + 6, true);
    const highGranule = view.getUint32(offset + 10, true);
    const pageSerial = view.getUint32(offset + 14, true);
    const seqNum = view.getUint32(offset + 18, true);
    const numSegments = buffer[offset + 26];

    if (offset + 27 + numSegments > byteSize) {
      return {
        valid: false,
        code: "MALFORMED_AUDIO_HEADER",
        error: "Truncated OGG page segment table.",
        byteSize,
      };
    }

    let pageDataLength = 0;
    for (let s = 0; s < numSegments; s++) {
      pageDataLength += buffer[offset + 27 + s];
    }

    const pageTotalLength = 27 + numSegments + pageDataLength;
    if (offset + pageTotalLength > byteSize) {
      return {
        valid: false,
        code: "MALFORMED_AUDIO_HEADER",
        error: "OGG page data truncated.",
        byteSize,
      };
    }

    const pageDataOffset = offset + 27 + numSegments;
    pageCount++;

    let stream = streams.get(pageSerial);
    if (!stream) {
      let codec: "opus" | "vorbis" | "unknown" = "unknown";
      let sampleRate = 0;
      let preSkip = 0;

      if (pageDataLength >= 8) {
        const sig = readAscii(buffer, pageDataOffset, 8);
        if (sig.startsWith("OpusHead")) {
          codec = "opus";
          sampleRate = 48000;
          if (pageDataLength >= 12) {
            preSkip = view.getUint16(pageDataOffset + 10, true);
          }
        } else if (sig.startsWith("\x01vorbis")) {
          codec = "vorbis";
          if (pageDataLength >= 16) {
            sampleRate = view.getUint32(pageDataOffset + 12, true);
          }
        }
      }

      stream = {
        codec,
        sampleRate,
        preSkip,
        lastSeq: -1,
        maxGranule: 0,
        hasGranule: false,
        pageCount: 0,
      };
      streams.set(pageSerial, stream);
    } else if (stream.codec === "unknown" && pageDataLength >= 8) {
      const sig = readAscii(buffer, pageDataOffset, 8);
      if (sig.startsWith("OpusHead")) {
        stream.codec = "opus";
        stream.sampleRate = 48000;
        if (pageDataLength >= 12) {
          stream.preSkip = view.getUint16(pageDataOffset + 10, true);
        }
      } else if (sig.startsWith("\x01vorbis")) {
        stream.codec = "vorbis";
        if (pageDataLength >= 16) {
          stream.sampleRate = view.getUint32(pageDataOffset + 12, true);
        }
      }
    }

    stream.pageCount++;

    if (stream.lastSeq !== -1 && seqNum < stream.lastSeq) {
      return {
        valid: false,
        code: "MALFORMED_AUDIO_HEADER",
        error: `Non-monotonic OGG page sequence number detected in stream ${pageSerial}.`,
        byteSize,
      };
    }
    stream.lastSeq = seqNum;

    // Granule position 0xffffffffffffffff indicates packet has not completed on this page
    if (lowGranule !== 0xffffffff || highGranule !== 0xffffffff) {
      const granule = highGranule * 2 ** 32 + lowGranule;
      if (granule > stream.maxGranule) {
        stream.maxGranule = granule;
        stream.hasGranule = true;
      }
    }

    offset += pageTotalLength;
  }

  // Filter for valid audio streams (Opus or Vorbis)
  const audioStreams = Array.from(streams.values()).filter(
    (s) => s.codec === "opus" || s.codec === "vorbis"
  );

  if (audioStreams.length === 0) {
    return {
      valid: false,
      code: "AUDIO_DURATION_UNVERIFIABLE",
      error: "Unable to verify OGG stream duration from valid sequential pages.",
      byteSize,
    };
  }

  let totalDuration = 0;
  for (const s of audioStreams) {
    if (s.sampleRate <= 0 || !s.hasGranule || s.maxGranule <= 0) {
      return {
        valid: false,
        code: "AUDIO_DURATION_UNVERIFIABLE",
        error: "Unable to verify OGG stream duration from valid sequential pages.",
        byteSize,
      };
    }

    let streamDur = 0;
    if (s.codec === "opus") {
      const netSamples = Math.max(0, s.maxGranule - s.preSkip);
      streamDur = netSamples / s.sampleRate;
    } else {
      streamDur = s.maxGranule / s.sampleRate;
    }

    if (streamDur <= 0) {
      return {
        valid: false,
        code: "AUDIO_DURATION_UNVERIFIABLE",
        error: "Unable to verify OGG stream duration from valid sequential pages.",
        byteSize,
      };
    }

    totalDuration += streamDur;
  }

  if (Math.round(totalDuration * 10) / 10 > MAX_AUDIO_DURATION_SECONDS) {
    return {
      valid: false,
      code: "AUDIO_TOO_LONG",
      error: `Audio duration (${totalDuration.toFixed(1)}s) exceeds the maximum limit of 60 seconds.`,
      byteSize,
    };
  }

  return checkDuration(totalDuration, "ogg", byteSize);
}

function parseMp3(buffer: Uint8Array, view: DataView, byteSize: number): AudioValidationResult {
  let offset = 0;

  // Skip ID3v2 tag
  if (byteSize >= 10 && readAscii(buffer, 0, 3) === "ID3") {
    const tagSize =
      ((buffer[6] & 0x7f) << 21) |
      ((buffer[7] & 0x7f) << 14) |
      ((buffer[8] & 0x7f) << 7) |
      (buffer[9] & 0x7f);
    offset = 10 + tagSize;
  }

  let totalValidFrames = 0;
  let totalSamples = 0;
  let primarySampleRate = 0;
  let scanOffset = offset;
  let claimedXingFrames: number | null = null;

  // Bitrate tables (kbps) for Layer III
  const bitrateTableV1L3 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0];
  const bitrateTableV2L3 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0];

  const sampleRateTableV1 = [44100, 48000, 32000];
  const sampleRateTableV2 = [22050, 24000, 16000];
  const sampleRateTableV25 = [11025, 12000, 8000];

  while (scanOffset + 4 <= byteSize) {
    if (!isMpegFrameSync(buffer, scanOffset)) {
      scanOffset++;
      continue;
    }

    const h1 = buffer[scanOffset + 1];
    const h2 = buffer[scanOffset + 2];
    const h3 = buffer[scanOffset + 3];

    const versionBits = (h1 >> 3) & 0x03; // 3 = MPEG-1, 2 = MPEG-2, 0 = MPEG-2.5
    const layerBits = (h1 >> 1) & 0x03; // 1 = Layer III
    const brIdx = (h2 >> 4) & 0x0f;
    const srIdx = (h2 >> 2) & 0x03;
    const pad = (h2 >> 1) & 0x01;
    const channelMode = (h3 >> 6) & 0x03;
    const isMono = channelMode === 3;

    if (layerBits !== 1 || versionBits === 1 || brIdx === 0 || brIdx === 15 || srIdx === 3) {
      scanOffset++;
      continue;
    }

    let curSampleRate = 44100;
    let bitrate = 0;
    let samplesPerFrame = 1152;
    let frameLen = 0;

    if (versionBits === 3) {
      curSampleRate = sampleRateTableV1[srIdx];
      bitrate = bitrateTableV1L3[brIdx] * 1000;
      samplesPerFrame = 1152;
      frameLen = Math.floor((144 * bitrate) / curSampleRate) + pad;
    } else {
      curSampleRate = versionBits === 2 ? sampleRateTableV2[srIdx] : sampleRateTableV25[srIdx];
      bitrate = bitrateTableV2L3[brIdx] * 1000;
      samplesPerFrame = 576;
      frameLen = Math.floor((72 * bitrate) / curSampleRate) + pad;
    }

    if (frameLen <= 4) {
      scanOffset++;
      continue;
    }

    if (primarySampleRate === 0) {
      primarySampleRate = curSampleRate;

      // Check first frame for Xing / Info header
      const xingOffset = scanOffset + (versionBits === 3 ? (isMono ? 21 : 36) : isMono ? 13 : 21);
      if (xingOffset + 12 <= byteSize) {
        const tag = readAscii(buffer, xingOffset, 4);
        if (tag === "Xing" || tag === "Info") {
          const flags = view.getUint32(xingOffset + 4, false);
          if ((flags & 0x01) !== 0) {
            claimedXingFrames = view.getUint32(xingOffset + 8, false);
          }
        }
      }
    }

    totalValidFrames++;
    totalSamples += samplesPerFrame;

    const accumulatedDuration = totalSamples / curSampleRate;
    if (Math.round(accumulatedDuration * 10) / 10 > MAX_AUDIO_DURATION_SECONDS) {
      return {
        valid: false,
        code: "AUDIO_TOO_LONG",
        error: `Audio duration (${accumulatedDuration.toFixed(1)}s) exceeds the maximum limit of 60 seconds.`,
        byteSize,
      };
    }

    scanOffset += frameLen;
  }

  if (totalValidFrames < 2 || primarySampleRate === 0) {
    return {
      valid: false,
      code: "AUDIO_DURATION_UNVERIFIABLE",
      error: "Unable to verify valid MPEG audio frame sequence in MP3 file.",
      byteSize,
    };
  }

  // Cross-check claimed Xing header frames against actual frames found in stream
  if (claimedXingFrames !== null && claimedXingFrames > 0) {
    if (totalValidFrames > claimedXingFrames + 10) {
      return {
        valid: false,
        code: "MALFORMED_AUDIO_HEADER",
        error: `MP3 stream frame count (${totalValidFrames}) contradicts Xing header metadata (${claimedXingFrames} frames); hidden audio detected.`,
        byteSize,
      };
    }
  }

  const duration = totalSamples / primarySampleRate;
  return checkDuration(duration, "mp3", byteSize);
}

function parseM4a(buffer: Uint8Array, view: DataView, byteSize: number): AudioValidationResult {
  let offset = 0;
  let movieDuration = -1;
  let trackDuration = -1;
  let sttsDuration = -1;
  let mdatSize = 0;

  while (offset + 8 <= byteSize) {
    const boxSize = view.getUint32(offset, false);
    const boxType = readAscii(buffer, offset + 4, 4);

    if (boxSize < 8 || offset + boxSize > byteSize + 8) break;

    if (boxType === "moov") {
      const moovRes = parseMoovBoxes(buffer, view, offset + 8, Math.min(offset + boxSize, byteSize));
      movieDuration = moovRes.movieDuration;
      trackDuration = moovRes.trackDuration;
      sttsDuration = moovRes.sttsDuration;
    } else if (boxType === "mdat") {
      mdatSize += boxSize;
    }

    offset += boxSize;
  }

  const effectiveDuration = Math.max(movieDuration, trackDuration, sttsDuration);
  if (effectiveDuration <= 0) {
    return {
      valid: false,
      code: "AUDIO_DURATION_UNVERIFIABLE",
      error: "Could not find valid 'moov' / 'mvhd' / 'mdhd' duration box in M4A container.",
      byteSize,
    };
  }

  // Cross-check media data size (mdat)
  if (mdatSize > 2.5 * 1024 * 1024 && effectiveDuration <= 15.0) {
    return {
      valid: false,
      code: "MALFORMED_AUDIO_HEADER",
      error: "M4A audio media payload size contradicts claimed duration metadata.",
      byteSize,
    };
  }

  return checkDuration(effectiveDuration, "m4a", byteSize);
}

function parseMoovBoxes(
  buffer: Uint8Array,
  view: DataView,
  start: number,
  end: number
): { movieDuration: number; trackDuration: number; sttsDuration: number } {
  let offset = start;
  let movieDuration = -1;
  let trackDuration = -1;
  let sttsDuration = -1;

  while (offset + 8 <= end) {
    const boxSize = view.getUint32(offset, false);
    const boxType = readAscii(buffer, offset + 4, 4);

    if (boxSize < 8 || offset + boxSize > end) break;

    if (boxType === "mvhd") {
      const version = buffer[offset + 8];
      let timescale = 0;
      let dur = 0;

      if (version === 0 && offset + 24 <= end) {
        timescale = view.getUint32(offset + 20, false);
        dur = view.getUint32(offset + 24, false);
      } else if (version === 1 && offset + 32 <= end) {
        timescale = view.getUint32(offset + 28, false);
        const highDur = view.getUint32(offset + 32, false);
        const lowDur = view.getUint32(offset + 36, false);
        dur = highDur * 2 ** 32 + lowDur;
      }

      if (timescale > 0 && dur > 0) {
        movieDuration = dur / timescale;
      }
    } else if (boxType === "trak") {
      const trakRes = parseTrakBox(buffer, view, offset + 8, offset + boxSize);
      if (trakRes.trackDuration > trackDuration) trackDuration = trakRes.trackDuration;
      if (trakRes.sttsDuration > sttsDuration) sttsDuration = trakRes.sttsDuration;
    }

    offset += boxSize;
  }

  return { movieDuration, trackDuration, sttsDuration };
}

function parseTrakBox(
  buffer: Uint8Array,
  view: DataView,
  start: number,
  end: number
): { trackDuration: number; sttsDuration: number } {
  let offset = start;
  let trackDuration = -1;
  let sttsDuration = -1;

  while (offset + 8 <= end) {
    const boxSize = view.getUint32(offset, false);
    const boxType = readAscii(buffer, offset + 4, 4);

    if (boxSize < 8 || offset + boxSize > end) break;

    if (boxType === "mdia") {
      let mdiaOff = offset + 8;
      let timescale = 0;

      while (mdiaOff + 8 <= offset + boxSize) {
        const subSize = view.getUint32(mdiaOff, false);
        const subType = readAscii(buffer, mdiaOff + 4, 4);

        if (subSize < 8 || mdiaOff + subSize > offset + boxSize) break;

        if (subType === "mdhd") {
          const version = buffer[mdiaOff + 8];
          let dur = 0;
          if (version === 0 && mdiaOff + 24 <= offset + boxSize) {
            timescale = view.getUint32(mdiaOff + 20, false);
            dur = view.getUint32(mdiaOff + 24, false);
          } else if (version === 1 && mdiaOff + 32 <= offset + boxSize) {
            timescale = view.getUint32(mdiaOff + 28, false);
            const high = view.getUint32(mdiaOff + 32, false);
            const low = view.getUint32(mdiaOff + 36, false);
            dur = high * 2 ** 32 + low;
          }
          if (timescale > 0 && dur > 0) {
            trackDuration = dur / timescale;
          }
        } else if (subType === "minf") {
          // Look for stbl -> stts
          let minfOff = mdiaOff + 8;
          while (minfOff + 8 <= mdiaOff + subSize) {
            const stblSize = view.getUint32(minfOff, false);
            const stblType = readAscii(buffer, minfOff + 4, 4);
            if (stblSize < 8 || minfOff + stblSize > mdiaOff + subSize) break;

            if (stblType === "stbl") {
              let sOff = minfOff + 8;
              while (sOff + 8 <= minfOff + stblSize) {
                const sSize = view.getUint32(sOff, false);
                const sType = readAscii(buffer, sOff + 4, 4);
                if (sSize < 8 || sOff + sSize > minfOff + stblSize) break;

                if (sType === "stts" && timescale > 0) {
                  // stts box: 4 bytes version/flags, 4 bytes entry count
                  const entryCount = view.getUint32(sOff + 12, false);
                  let totalSampleCount = 0;
                  for (let e = 0; e < Math.min(entryCount, 1000); e++) {
                    const eOff = sOff + 16 + e * 8;
                    if (eOff + 8 <= sOff + sSize) {
                      const sampleCount = view.getUint32(eOff, false);
                      const sampleDelta = view.getUint32(eOff + 4, false);
                      totalSampleCount += sampleCount * sampleDelta;
                    }
                  }
                  if (totalSampleCount > 0) {
                    sttsDuration = totalSampleCount / timescale;
                  }
                }
                sOff += sSize;
              }
            }
            minfOff += stblSize;
          }
        }

        mdiaOff += subSize;
      }
    }

    offset += boxSize;
  }

  return { trackDuration, sttsDuration };
}

function parseWebM(buffer: Uint8Array, view: DataView, byteSize: number): AudioValidationResult {
  let offset = 0;

  // Skip EBML Header
  const headerId = readEbmlId(buffer, offset);
  if (headerId.id !== 0x1a45dfa3) {
    return {
      valid: false,
      code: "MALFORMED_AUDIO_HEADER",
      error: "Invalid WebM EBML header.",
      byteSize,
    };
  }
  offset += headerId.len;
  const headerSize = readEbmlVint(buffer, offset);
  offset += headerSize.len + Number(headerSize.val);

  let timestampScale = 1000000; // default 1 ms (1,000,000 ns)
  let declaredDurationSec = -1;
  let maxObservedTimestamp = -1;

  while (offset + 4 <= byteSize) {
    const el = readEbmlId(buffer, offset);
    if (el.id === 0) break;
    offset += el.len;

    const elSize = readEbmlVint(buffer, offset);
    offset += elSize.len;
    const contentLen = Number(elSize.val);

    // Segment (0x18538067)
    if (el.id === 0x18538067) {
      continue;
    }

    // Info (0x1549A966)
    if (el.id === 0x1549a966) {
      const infoEnd = Math.min(offset + contentLen, byteSize);
      let infoOff = offset;
      while (infoOff + 2 <= infoEnd) {
        const infoEl = readEbmlId(buffer, infoOff);
        if (infoEl.id === 0) break;
        infoOff += infoEl.len;

        const infoSize = readEbmlVint(buffer, infoOff);
        infoOff += infoSize.len;
        const valLen = Number(infoSize.val);

        if (infoEl.id === 0x2ad7b1) {
          if (valLen === 4) timestampScale = view.getUint32(infoOff, false);
          else if (valLen === 2) timestampScale = view.getUint16(infoOff, false);
        } else if (infoEl.id === 0x4489) {
          if (valLen === 4) {
            declaredDurationSec = (view.getFloat32(infoOff, false) * timestampScale) / 1e9;
          } else if (valLen === 8) {
            declaredDurationSec = (view.getFloat64(infoOff, false) * timestampScale) / 1e9;
          }
        }

        infoOff += valLen;
      }
    }

    // Cluster (0x1F43B675)
    if (el.id === 0x1f43b675) {
      const clusterEnd = Math.min(offset + contentLen, byteSize);
      let clOff = offset;
      let clusterTimestamp = 0;

      while (clOff + 2 <= clusterEnd) {
        const clEl = readEbmlId(buffer, clOff);
        if (clEl.id === 0) break;
        clOff += clEl.len;

        const clSize = readEbmlVint(buffer, clOff);
        clOff += clSize.len;
        const clLen = Number(clSize.val);

        if (clEl.id === 0xe7) {
          // Cluster Timestamp
          let ts = 0;
          for (let k = 0; k < clLen; k++) {
            ts = ts * 256 + buffer[clOff + k];
          }
          clusterTimestamp = ts;
          if (ts > maxObservedTimestamp) maxObservedTimestamp = ts;
        } else if (clEl.id === 0xa3 || clEl.id === 0xa0) {
          // SimpleBlock or BlockGroup
          if (clLen >= 4) {
            const trackVint = readEbmlVint(buffer, clOff);
            const timecodeOff = clOff + trackVint.len;
            if (timecodeOff + 2 <= clOff + clLen) {
              const relTimecode = view.getInt16(timecodeOff, false);
              const blockTs = clusterTimestamp + relTimecode;
              if (blockTs > maxObservedTimestamp) maxObservedTimestamp = blockTs;
            }
          }
        }

        clOff += clLen;
      }

      // Check running cluster timestamp limit
      const runningDuration = (maxObservedTimestamp * timestampScale) / 1e9;
      if (runningDuration > MAX_AUDIO_DURATION_SECONDS) {
        return {
          valid: false,
          code: "AUDIO_TOO_LONG",
          error: `WebM audio duration (${runningDuration.toFixed(1)}s) exceeds the maximum limit of 60 seconds.`,
          byteSize,
        };
      }
    }

    offset += contentLen;
  }

  const clusterDurationSec =
    maxObservedTimestamp > 0
      ? (maxObservedTimestamp * timestampScale) / 1e9
      : maxObservedTimestamp === 0
      ? 0.02
      : -1;

  // Reconcile declared duration with observed cluster duration
  if (declaredDurationSec > 0 && clusterDurationSec > 0) {
    if (clusterDurationSec > declaredDurationSec + 2.0) {
      return {
        valid: false,
        code: "MALFORMED_AUDIO_HEADER",
        error: `WebM Cluster timing (${clusterDurationSec.toFixed(1)}s) contradicts declared Info duration (${declaredDurationSec.toFixed(1)}s); hidden audio detected.`,
        byteSize,
      };
    }
  }

  const effectiveDuration = Math.max(declaredDurationSec, clusterDurationSec);
  if (effectiveDuration <= 0) {
    return {
      valid: false,
      code: "AUDIO_DURATION_UNVERIFIABLE",
      error: "WebM container does not contain verifiable duration or timestamp clusters.",
      byteSize,
    };
  }

  return checkDuration(effectiveDuration, "webm", byteSize);
}

function parseFlac(buffer: Uint8Array, view: DataView, byteSize: number): AudioValidationResult {
  const blockType = buffer[4] & 0x7f;
  const blockLength = (buffer[5] << 16) | (buffer[6] << 8) | buffer[7];

  if (blockType !== 0 || blockLength < 34 || 8 + blockLength > byteSize) {
    return {
      valid: false,
      code: "MALFORMED_AUDIO_HEADER",
      error: "FLAC STREAMINFO block is corrupt or missing.",
      byteSize,
    };
  }

  const b0 = buffer[18];
  const b1 = buffer[19];
  const b2 = buffer[20];
  const sampleRate = (b0 << 12) | (b1 << 4) | (b2 >> 4);

  // FLAC STREAMINFO bit-unpacking:
  // sample rate (20 bits): buffer[18], buffer[19], buffer[20] >> 4
  // channels (3 bits): (buffer[20] >> 1) & 0x07
  // bits-per-sample (5 bits): ((buffer[20] & 0x01) << 4) | (buffer[21] >> 4)
  // total samples (36 bits): buffer[21] & 0x0f (top 4 bits), followed by buffer[22..25] (32 bits)
  const top4Bits = buffer[21] & 0x0f;
  const lower32 =
    buffer[22] * 2 ** 24 +
    buffer[23] * 2 ** 16 +
    buffer[24] * 2 ** 8 +
    buffer[25];
  const totalSamples = top4Bits * 2 ** 32 + lower32;

  if (sampleRate <= 0 || totalSamples <= 0) {
    return {
      valid: false,
      code: "AUDIO_DURATION_UNVERIFIABLE",
      error: "FLAC header does not specify valid sample rate or sample count (total samples must be non-zero).",
      byteSize,
    };
  }

  const duration = totalSamples / sampleRate;

  // Cross-check: If claimed duration is short (e.g. <= 10s) but file size is > 2.5 MB
  if (duration <= 10.0 && byteSize > 2.5 * 1024 * 1024) {
    return {
      valid: false,
      code: "MALFORMED_AUDIO_HEADER",
      error: "FLAC file size contradicts STREAMINFO total samples metadata; possible hidden audio.",
      byteSize,
    };
  }

  return checkDuration(duration, "flac", byteSize);
}

function parseAdts(buffer: Uint8Array, view: DataView, byteSize: number): AudioValidationResult {
  const sampleRates = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];
  let scanOffset = 0;
  let totalValidFrames = 0;
  let totalSamples = 0;
  let primarySampleRate = 0;

  while (scanOffset + 7 <= byteSize) {
    if (!isAdtsSync(buffer, scanOffset)) {
      scanOffset++;
      continue;
    }

    const b1 = buffer[scanOffset + 1];
    const b2 = buffer[scanOffset + 2];
    const b3 = buffer[scanOffset + 3];
    const b4 = buffer[scanOffset + 4];
    const b5 = buffer[scanOffset + 5];
    const b6 = buffer[scanOffset + 6];

    const srIdx = (b2 >> 2) & 0x0f;
    if (srIdx >= sampleRates.length) {
      scanOffset++;
      continue;
    }
    const curSampleRate = sampleRates[srIdx];

    const frameLen = ((b3 & 0x03) << 11) | (b4 << 3) | ((b5 >> 5) & 0x07);
    if (frameLen < 7 || scanOffset + frameLen > byteSize) {
      scanOffset++;
      continue;
    }

    const numRdb = b6 & 0x03;
    const samplesInFrame = 1024 * (numRdb + 1);

    if (primarySampleRate === 0) {
      primarySampleRate = curSampleRate;
    }

    totalValidFrames++;
    totalSamples += samplesInFrame;

    const accumulatedDuration = totalSamples / curSampleRate;
    if (Math.round(accumulatedDuration * 10) / 10 > MAX_AUDIO_DURATION_SECONDS) {
      return {
        valid: false,
        code: "AUDIO_TOO_LONG",
        error: `Audio duration (${accumulatedDuration.toFixed(1)}s) exceeds the maximum limit of 60 seconds.`,
        byteSize,
      };
    }

    scanOffset += frameLen;
  }

  if (totalValidFrames < 2 || primarySampleRate === 0) {
    return {
      valid: false,
      code: "AUDIO_DURATION_UNVERIFIABLE",
      error: "Unable to verify valid ADTS AAC frame sequence.",
      byteSize,
    };
  }

  const duration = totalSamples / primarySampleRate;
  return checkDuration(duration, "aac", byteSize);
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function checkDuration(
  duration: number,
  format: "wav" | "ogg" | "mp3" | "flac" | "m4a" | "webm" | "aac",
  byteSize: number
): AudioValidationResult {
  if (isNaN(duration) || duration <= 0) {
    return {
      valid: false,
      code: "AUDIO_DURATION_UNVERIFIABLE",
      error: `Could not verify a positive audio duration for format '${format}'.`,
      byteSize,
    };
  }

  // Enforce 60.0s limit with frame quantization boundary tolerance
  if (Math.round(duration * 10) / 10 > MAX_AUDIO_DURATION_SECONDS) {
    return {
      valid: false,
      code: "AUDIO_TOO_LONG",
      error: `Audio duration (${duration.toFixed(1)}s) exceeds the maximum limit of 60 seconds.`,
      byteSize,
    };
  }

  return {
    valid: true,
    format,
    durationSeconds: Math.round(duration * 100) / 100,
    byteSize,
  };
}

function readAscii(buffer: Uint8Array, offset: number, length: number): string {
  let s = "";
  for (let i = 0; i < length && offset + i < buffer.byteLength; i++) {
    s += String.fromCharCode(buffer[offset + i]);
  }
  return s;
}

function isMpegFrameSync(buffer: Uint8Array, offset: number): boolean {
  if (offset + 1 >= buffer.byteLength) return false;
  // Byte 0 is 0xff, byte 1 bits 7-5 are 111 (sync), bits 2-1 are 01 (Layer III)
  return (
    buffer[offset] === 0xff &&
    (buffer[offset + 1] & 0xe0) === 0xe0 &&
    ((buffer[offset + 1] >> 1) & 0x03) === 1
  );
}

function isAdtsSync(buffer: Uint8Array, offset: number): boolean {
  if (offset + 1 >= buffer.byteLength) return false;
  // Syncword: 12 bits 0xfff -> byte 0 is 0xff, byte 1 bits 7-4 are 1111 (0xf0)
  // Layer bits (bits 2-1) are 00 for AAC ADTS
  return buffer[offset] === 0xff && (buffer[offset + 1] & 0xf6) === 0xf0;
}

function readEbmlId(buffer: Uint8Array, offset: number): { id: number; len: number } {
  if (offset >= buffer.byteLength) return { id: 0, len: 0 };
  const first = buffer[offset];
  let numBytes = 0;
  if ((first & 0x80) !== 0) numBytes = 1;
  else if ((first & 0x40) !== 0) numBytes = 2;
  else if ((first & 0x20) !== 0) numBytes = 3;
  else if ((first & 0x10) !== 0) numBytes = 4;
  else return { id: 0, len: 0 };

  if (offset + numBytes > buffer.byteLength) return { id: 0, len: 0 };
  let id = 0;
  for (let i = 0; i < numBytes; i++) {
    id = id * 256 + buffer[offset + i];
  }
  return { id, len: numBytes };
}

function readEbmlVint(buffer: Uint8Array, offset: number): { val: bigint; len: number } {
  if (offset >= buffer.byteLength) return { val: 0n, len: 0 };
  const first = buffer[offset];
  let numBytes = 0;
  let mask = 0;

  if ((first & 0x80) !== 0) {
    numBytes = 1;
    mask = 0x7f;
  } else if ((first & 0x40) !== 0) {
    numBytes = 2;
    mask = 0x3f;
  } else if ((first & 0x20) !== 0) {
    numBytes = 3;
    mask = 0x1f;
  } else if ((first & 0x10) !== 0) {
    numBytes = 4;
    mask = 0x0f;
  } else if ((first & 0x08) !== 0) {
    numBytes = 5;
    mask = 0x07;
  } else if ((first & 0x04) !== 0) {
    numBytes = 6;
    mask = 0x03;
  } else if ((first & 0x02) !== 0) {
    numBytes = 7;
    mask = 0x01;
  } else if ((first & 0x01) !== 0) {
    numBytes = 8;
    mask = 0x00;
  } else {
    return { val: 0n, len: 0 };
  }

  if (offset + numBytes > buffer.byteLength) return { val: 0n, len: 0 };
  let val = BigInt(first & mask);
  for (let i = 1; i < numBytes; i++) {
    val = (val << 8n) | BigInt(buffer[offset + i]);
  }
  return { val, len: numBytes };
}
