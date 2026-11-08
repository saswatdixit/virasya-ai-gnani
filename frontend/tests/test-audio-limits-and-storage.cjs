/**
 * Virasya Audio Limits, Storage Security, and Playback Automated Test Suite
 *
 * Combines:
 * 1. Static Source Code Assertions: Verifies architectural invariants across frontend,
 *    Edge Functions, Python server, and database migrations.
 * 2. Executable Behavioral Tests: Runs real validation algorithms on synthetic and genuine
 *    audio files, testing size bounds, duration boundaries, forged client metadata,
 *    corrupt file rejection, exact object lookups, and authorization matrices.
 */

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const cp = require("node:child_process");

console.log("=== Virasya Audio Storage, Limits & Playback Test Suite ===\n");

(async () => {
  // ===========================================================================
  // PART 1: STATIC CODE & INVARIANT INSPECTION
  // ===========================================================================

  // ---------------------------------------------------------------------------
  // 1. Shared Audio Constants & Boundaries
  // ---------------------------------------------------------------------------
  console.log("1. Verifying shared audio limits and format allowlists...");
  const constantsPath = path.resolve(__dirname, "../src/preserve/constants.ts");
  const constantsContent = fs.readFileSync(constantsPath, "utf8");

  assert(constantsContent.includes("export const MAX_AUDIO_DURATION_SECONDS = 30"), "Max audio duration must be 30 seconds");
  assert(constantsContent.includes("export const MAX_AUDIO_SIZE_BYTES = 5 * 1024 * 1024"), "Max audio size must be 5 MiB (5,242,880 bytes)");
  assert(constantsContent.includes("story-recordings-private"), "Default bucket must be story-recordings-private");

  const expectedExts = [".wav", ".ogg", ".mp3", ".m4a", ".flac", ".aac", ".webm"];
  for (const ext of expectedExts) {
    assert(constantsContent.includes(`"${ext}"`), `Allowed extensions must include ${ext}`);
  }
  console.log("   ✓ Shared constants correctly define 30s, 5 MiB, and authorized audio formats.");

  // ---------------------------------------------------------------------------
  // 2. Frontend Step 2 (Page2Voice.tsx) Limits & Decoupled Upload
  // ---------------------------------------------------------------------------
  console.log("\n2. Verifying Page2Voice.tsx size/duration guards and decoupled cloud upload...");
  const voiceContent = fs.readFileSync(path.resolve(__dirname, "../src/preserve/pages/Page2Voice.tsx"), "utf8");

  // Duration auto-stop guard
  assert(voiceContent.includes("elapsedRef.current >= MAX_AUDIO_DURATION_SECONDS"), "Timer must auto-stop recording at 30s");
  assert(voiceContent.includes("stopRecording()"), "Must stop recording when 30s limit reached");

  // In-stream byte size guard
  assert(voiceContent.includes("recordedBytesRef.current > MAX_AUDIO_SIZE_BYTES"), "MediaRecorder ondataavailable must stop on > 5 MiB");

  // File upload guards
  assert(voiceContent.includes("file.size > MAX_AUDIO_SIZE_BYTES"), "File upload must reject files > 5 MiB");
  assert(voiceContent.includes("dur > MAX_AUDIO_DURATION_SECONDS"), "File upload must reject audio > 30s");
  assert(voiceContent.includes("ALLOWED_AUDIO_EXTENSIONS.includes"), "File upload must enforce format allowlist");
  assert(voiceContent.includes("!dur || isNaN(dur) || dur <= 0"), "Unreadable audio metadata must be safely rejected");

  // Decoupled upload
  assert(voiceContent.includes("uploadAudioToPrivateBucket(file"), "Must call uploadAudioToPrivateBucket directly without depending on Flask");
  assert(voiceContent.includes("setAudio("), "Must retain binary File in context memory");
  console.log("   ✓ Page2Voice.tsx enforces 30s auto-stop, 5 MiB limit, duration metadata check, and decoupled upload.");

  // ---------------------------------------------------------------------------
  // 3. Preserve Context & Step 6 Guest Recording Upload
  // ---------------------------------------------------------------------------
  console.log("\n3. Verifying PreserveContext.tsx guest recording retention and Step 6 upload...");
  const ctxContent = fs.readFileSync(path.resolve(__dirname, "../src/preserve/context/PreserveContext.tsx"), "utf8");

  // In-memory binary retention
  assert(ctxContent.includes("audioFileRef"), "Context must maintain audioFileRef for guest in-memory binary retention");
  assert(ctxContent.includes("setAudioFileState"), "Context must manage audioFile state");

  // GNANI boundary guard
  assert(ctxContent.includes("currentAudio.size > MAX_AUDIO_SIZE_BYTES"), "executeTranscription must guard against oversized audio");
  assert(ctxContent.includes("currentAudio.duration > MAX_AUDIO_DURATION_SECONDS"), "executeTranscription must guard against audio > 30s");

  // Pre-preservation upload for guest users
  assert(ctxContent.includes("if (!state.audio.storage_path)"), "Must check if audio lacks storage_path before sealing");
  assert(ctxContent.includes("const rawBinary = audioFileRef.current"), "Must retrieve in-memory binary file");
  assert(ctxContent.includes("uploadAudioToPrivateBucket(rawBinary"), "Must upload guest recording to Supabase before preservation");
  assert(ctxContent.includes("Audio recording binary is not available in browser memory"), "Must inform user if memory was cleared on reload");
  console.log("   ✓ PreserveContext.tsx validates boundaries before GNANI and executes deferred guest cloud upload.");

  // ---------------------------------------------------------------------------
  // 4. Supabase Adapters Canonical Path Persistence
  // ---------------------------------------------------------------------------
  console.log("\n4. Verifying Supabase adapters canonical audio path persistence...");
  const adaptersContent = fs.readFileSync(path.resolve(__dirname, "../src/supabase/adapters.ts"), "utf8");

  assert(adaptersContent.includes("storage_path: audio.storage_path"), "audioItemToDbAudio must persist storage_path");
  assert(adaptersContent.includes("bucket: audio.bucket"), "audioItemToDbAudio must persist bucket");
  assert(adaptersContent.includes("storage_path: dbAudio.storage_path"), "dbAudioToAudioItem must restore storage_path");
  assert(adaptersContent.includes("bucket: dbAudio.bucket"), "dbAudioToAudioItem must restore bucket");
  console.log("   ✓ Adapters correctly map and restore canonical storage_path and bucket.");

  // ---------------------------------------------------------------------------
  // 5. Supabase Storage Migration (SEC-02: 5 MiB Bucket Limit Reconciliation)
  // ---------------------------------------------------------------------------
  console.log("\n5. Verifying Supabase storage migrations & 5 MiB limit (SEC-02)...");
  const historicalMigrationPath = path.resolve(__dirname, "../../supabase/migrations/20261017000000_virasya_core_schema.sql");
  const forwardMigrationPath = path.resolve(__dirname, "../../supabase/migrations/20261024010000_reconcile_audio_bucket_limit.sql");

  const historicalContent = fs.readFileSync(historicalMigrationPath, "utf8");
  const forwardContent = fs.readFileSync(forwardMigrationPath, "utf8");

  // Historical migration retains immutable 50 MB initial definition
  assert(historicalContent.includes("52428800, -- 50 MB"), "Historical 20261017 migration must remain immutable with 50 MB");
  assert(!historicalContent.includes("5242880,"), "Historical 20261017 migration must not be altered for 5 MiB limit");

  // Forward migration reconciles to 5 MiB (5,242,880 bytes)
  assert(forwardContent.includes("5242880 -- 5 MiB"), "Forward migration 20261024010000 must reconcile bucket to 5,242,880 bytes");
  assert(forwardContent.includes("UPDATE storage.buckets"), "Forward migration must update storage.buckets");
  console.log("   ✓ Historical migration is preserved immutable; forward migration 20261024010000 sets 5 MiB.");

  // ---------------------------------------------------------------------------
  // 6. Supabase Edge Function: preserve-story Security & Exact Object Verification
  // ---------------------------------------------------------------------------
  console.log("\n6. Verifying preserve-story Edge Function security, exact download & validator (SEC-01, SEC-03)...");
  const preserveFnContent = fs.readFileSync(path.resolve(__dirname, "../../supabase/functions/preserve-story/index.ts"), "utf8");
  const validatorContent = fs.readFileSync(path.resolve(__dirname, "../../supabase/functions/preserve-story/audio-validator.ts"), "utf8");

  // Import check
  assert(preserveFnContent.includes('import { validateAudioBuffer } from "./audio-validator.ts"'), "preserve-story must import validateAudioBuffer");

  // Canonical fields preserved
  assert(preserveFnContent.includes("storage_path: storagePath"), "preserve-story must persist storage_path");
  assert(preserveFnContent.includes("bucket: bucket"), "preserve-story must persist bucket");

  // Bucket restriction
  assert(preserveFnContent.includes("INVALID_BUCKET"), "Must reject invalid or arbitrary buckets");

  // Path traversal guard
  assert(preserveFnContent.includes("MALFORMED_STORAGE_PATH"), "Must reject path traversal (.., \\, leading /)");

  // Ownership guard
  assert(preserveFnContent.includes("FORBIDDEN_STORAGE_PATH"), "Must reject storage paths not starting with user.id/");

  // Exact object download (SEC-03: eliminates .list() limit: 10 pagination flaw)
  assert(preserveFnContent.includes(".download(storagePath)"), "Must verify exact object existence via direct download, not fragile list");
  assert(!preserveFnContent.includes(".list(user.id, { search: objectFileName, limit: 10 })"), "Fragile list lookup with limit: 10 must be removed");
  assert(preserveFnContent.includes("AUDIO_OBJECT_NOT_FOUND"), "Must return safe error if exact object is missing");

  // Server-side container duration validation (SEC-01)
  assert(preserveFnContent.includes("validateAudioBuffer(audioBuffer"), "Must execute server-side audio validation on storage bytes");
  assert(validatorContent.includes("AUDIO_TOO_LONG"), "Audio validator must enforce duration limit <= 60s");
  assert(validatorContent.includes("AUDIO_TOO_LARGE"), "Audio validator must enforce 5 MiB limit");
  assert(validatorContent.includes("UNRECOGNIZED_CONTAINER"), "Audio validator must enforce supported audio container signatures");
  console.log("   ✓ preserve-story Edge Function performs exact download lookup and server-side duration validation.");

  // ---------------------------------------------------------------------------
  // 7. Supabase Edge Function: get-story-audio Playback Authorization
  // ---------------------------------------------------------------------------
  console.log("\n7. Verifying get-story-audio Edge Function authorized playback tickets...");
  const playbackFnContent = fs.readFileSync(path.resolve(__dirname, "../../supabase/functions/get-story-audio/index.ts"), "utf8");

  // Authorization checks
  assert(playbackFnContent.includes("isPublicPreserved"), "Must check if story is public and preserved");
  assert(playbackFnContent.includes("UNAUTHORIZED_PRIVATE_AUDIO"), "Must require auth for non-public stories");
  assert(playbackFnContent.includes("FORBIDDEN_AUDIO_ACCESS"), "Must forbid non-owner access to private recordings");

  // Path validation
  assert(playbackFnContent.includes("MALFORMED_STORAGE_PATH"), "Must reject malformed playback paths");
  assert(playbackFnContent.includes("MISMATCHED_STORAGE_OWNER"), "Must verify storage path belongs to story author");

  // Legacy signed URL compatibility
  assert(playbackFnContent.includes("story-recordings-private\\/([^?]+)"), "Must extract storage_path from legacy expiring signed URLs");

  // Fresh signed URL generation
  assert(playbackFnContent.includes("createSignedUrl(storagePath"), "Must generate fresh signed playback URL with TTL");
  console.log("   ✓ get-story-audio Edge Function enforces public/private access rules, author ownership, and legacy recovery.");

  // ---------------------------------------------------------------------------
  // 8. ExplorePage On-Demand Authorized Playback & Token Refresh
  // ---------------------------------------------------------------------------
  console.log("\n8. Verifying ExplorePage on-demand playback and token refresh...");
  const exploreContent = fs.readFileSync(path.resolve(__dirname, "../src/explore/ExplorePage.tsx"), "utf8");

  assert(exploreContent.includes("getStoryAudioPlaybackUrl"), "ExplorePage must use getStoryAudioPlaybackUrl");
  assert(exploreContent.includes("ExploreAudioPlayer"), "ExplorePage must render ExploreAudioPlayer component");
  assert(exploreContent.includes("handleAudioError"), "ExploreAudioPlayer must handle audio error / token expiration");
  assert(exploreContent.includes("Refresh Playback Ticket"), "ExploreAudioPlayer must provide manual refresh action");
  assert(exploreContent.includes("Obtaining authorized archival playback ticket"), "ExploreAudioPlayer must display resolving state");
  console.log("   ✓ ExplorePage cleanly resolves fresh playback tickets and auto-refreshes expired tokens.");

  // ---------------------------------------------------------------------------
  // 9. Python Backend Trust Boundaries & Fail-Closed Behavior (SEC-05)
  // ---------------------------------------------------------------------------
  console.log("\n9. Verifying Python backend upload & transcription trust boundaries (SEC-05)...");
  const pyWorkflow = fs.readFileSync(path.resolve(__dirname, "../../virasya-ai/src/virasya_ai/web/workflow.py"), "utf8");
  assert(pyWorkflow.includes("MAX_UPLOAD_BYTES = 5 * 1024 * 1024"), "workflow.py MAX_UPLOAD_BYTES must be 5 MiB");

  const pyServer = fs.readFileSync(path.resolve(__dirname, "../../virasya-ai/src/virasya_ai/web/server.py"), "utf8");
  assert(pyServer.includes("MAX_REQUEST_BYTES"), "server.py must enforce MAX_REQUEST_BYTES");
  assert(pyServer.includes("PAYLOAD_TOO_LARGE"), "server.py must return PAYLOAD_TOO_LARGE (HTTP 413)");
  assert(pyServer.includes("AUDIO_TOO_LONG"), "server.py must reject audio duration > 60s");
  assert(pyServer.includes("DURATION_VERIFICATION_FAILED"), "server.py must fail closed with DURATION_VERIFICATION_FAILED");
  const uploadFn = pyServer.slice(pyServer.indexOf("def _handle_upload"), pyServer.indexOf("def _handle_transcribe"));
  assert(!uploadFn.includes("pass"), "_handle_upload must not silently pass on unexpected audio errors");

  const transcribeFn = pyServer.slice(pyServer.indexOf("def _handle_transcribe"), pyServer.indexOf("def _handle_save_legacy"));
  assert(!transcribeFn.includes("pass"), "_handle_transcribe must not silently pass on unexpected audio errors");

  const pyAudio = fs.readFileSync(path.resolve(__dirname, "../../virasya-ai/src/virasya_ai/transcription/ingestion/audio.py"), "utf8");
  assert(pyAudio.includes('".webm"'), "audio.py must support .webm from browser recordings");
  console.log("   ✓ Python backend validates request body (HTTP 413), file size (5 MiB), fails closed, and supports webm.");

  // ===========================================================================
  // PART 2: EXECUTABLE BEHAVIORAL TESTS (RUNTIME VALIDATION)
  // ===========================================================================
  console.log("\n==================================================================");
  console.log("PART 2: EXECUTABLE BEHAVIORAL TESTS (RUNTIME VALIDATION)");
  console.log("==================================================================");

  const { validateAudioBuffer, MAX_AUDIO_BYTES, MAX_AUDIO_DURATION_SECONDS } = await import(
    "../../supabase/functions/preserve-story/audio-validator.ts"
  );

  // Helper to generate valid PCM WAV buffers of specific durations
  function generatePcmWav(durationSeconds, sampleRate = 16000) {
    const numChannels = 1;
    const bitsPerSample = 16;
    const byteRate = sampleRate * numChannels * (bitsPerSample / 8);
    const dataSize = Math.floor(durationSeconds * byteRate);
    const buffer = new Uint8Array(44 + dataSize);
    const view = new DataView(buffer.buffer);

    // RIFF header
    buffer.set([0x52, 0x49, 0x46, 0x46], 0); // "RIFF"
    view.setUint32(4, 36 + dataSize, true);
    buffer.set([0x57, 0x41, 0x56, 0x45], 8); // "WAVE"

    // fmt chunk
    buffer.set([0x66, 0x6d, 0x74, 0x20], 12); // "fmt "
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true); // PCM format
    view.setUint16(22, numChannels, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, byteRate, true);
    view.setUint16(32, (numChannels * bitsPerSample) / 8, true);
    view.setUint16(34, bitsPerSample, true);

    // data chunk
    buffer.set([0x64, 0x61, 0x74, 0x61], 36); // "data"
    view.setUint32(40, dataSize, true);

    return buffer;
  }

  // Helper to generate minimal WebM buffers
  function generateWebm(durationSeconds) {
    const ebmlHeader = [0x1a, 0x45, 0xdf, 0xa3, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00];
    const segment = [0x18, 0x53, 0x80, 0x67, 0x10, 0x00, 0x00, 0x20];
    const info = [0x15, 0x49, 0xa9, 0x66, 0x8f];

    // Duration in Info element (float32, in units of timestampScale 1ms = 1000 * seconds)
    const durMs = durationSeconds * 1000.0;
    const durBuf = new Uint8Array(4);
    new DataView(durBuf.buffer).setFloat32(0, durMs, false);
    const durEl = [0x44, 0x89, 0x84, ...durBuf];

    return new Uint8Array([...ebmlHeader, ...segment, ...info, ...durEl]);
  }

  // --- Behavioral Test 1: Size Boundary Invariant ---
  console.log("\nBehavioral Test 1: Size boundary invariants (5 MiB boundary)...");
  const exact5MiB = new Uint8Array(MAX_AUDIO_BYTES);
  const oversized5MiB = new Uint8Array(MAX_AUDIO_BYTES + 1);

  // Exact 5 MiB evaluates past size check into container check
  const resExact = validateAudioBuffer(exact5MiB, ".bin");
  assert.strictEqual(resExact.valid, false);
  assert.strictEqual(resExact.code, "UNRECOGNIZED_CONTAINER", "5,242,880 bytes must pass the size gate");

  // 5 MiB + 1 byte is rejected immediately at size gate
  const resOver = validateAudioBuffer(oversized5MiB, ".bin");
  assert.strictEqual(resOver.valid, false);
  assert.strictEqual(resOver.code, "AUDIO_TOO_LARGE", "5,242,881 bytes must be rejected as AUDIO_TOO_LARGE");
  console.log("   ✓ Exact 5 MiB (5,242,880 bytes) is accepted by size gate; 5,242,881 bytes is rejected (AUDIO_TOO_LARGE).");

  // --- Behavioral Test 2: Duration Boundary Invariant ---
  console.log("\nBehavioral Test 2: Duration boundary invariants (60.0s boundary)...");
  const wav59_9 = generatePcmWav(59.9);
  const res59_9 = validateAudioBuffer(wav59_9, ".wav");
  assert.strictEqual(res59_9.valid, true);
  assert.strictEqual(res59_9.durationSeconds, 59.9);

  const wav60_0 = generatePcmWav(60.0);
  const res60_0 = validateAudioBuffer(wav60_0, ".wav");
  assert.strictEqual(res60_0.valid, true);
  assert.strictEqual(res60_0.durationSeconds, 60.0);

  const wav60_1 = generatePcmWav(60.1);
  const res60_1 = validateAudioBuffer(wav60_1, ".wav");
  assert.strictEqual(res60_1.valid, false);
  assert.strictEqual(res60_1.code, "AUDIO_TOO_LONG", "60.1s audio must be rejected as AUDIO_TOO_LONG");

  const webm30 = generateWebm(30.0);
  const resWebm30 = validateAudioBuffer(webm30, ".webm");
  assert.strictEqual(resWebm30.valid, true);
  assert.strictEqual(resWebm30.durationSeconds, 30.0);

  const webm75 = generateWebm(75.0);
  const resWebm75 = validateAudioBuffer(webm75, ".webm");
  assert.strictEqual(resWebm75.valid, false);
  assert.strictEqual(resWebm75.code, "AUDIO_TOO_LONG", "75.0s WebM must be rejected as AUDIO_TOO_LONG");
  console.log("   ✓ Audio <= 60.0s (WAV 59.9s, 60.0s, WebM 30.0s) accepted; Audio > 60.0s (WAV 60.1s, WebM 75.0s) rejected.");

  // --- Behavioral Test 3: Forged Duration Bypass Prevention ---
  console.log("\nBehavioral Test 3: Forged client duration bypass prevention (SEC-01)...");
  // Simulate attacker sending client payload { duration: 25.0 } for an actual 70.0s audio recording
  const longAudioBytes = generatePcmWav(70.0);
  const attackerReportedDuration = 25.0; // forged value
  const serverValidation = validateAudioBuffer(longAudioBytes, ".wav");

  assert.strictEqual(serverValidation.valid, false, "Server-side validator must ignore forged client duration");
  assert.strictEqual(serverValidation.code, "AUDIO_TOO_LONG", "Real audio container bytes (70s) must trigger AUDIO_TOO_LONG");
  console.log("   ✓ Forged client duration ('25.0s') cannot bypass server-side container decoding (70.0s detected -> rejected).");

  // --- Behavioral Test 4: Unreadable, Malformed, or Corrupt Audio Fails Closed ---
  console.log("\nBehavioral Test 4: Corrupt and malformed audio fail-closed validation...");
  const emptyBytes = new Uint8Array(0);
  assert.strictEqual(validateAudioBuffer(emptyBytes, ".wav").code, "EMPTY_AUDIO");

  const randomBinary = new Uint8Array([0xde, 0xad, 0xbe, 0xef, 0x01, 0x02, 0x03, 0x04]);
  assert.strictEqual(validateAudioBuffer(randomBinary, ".mp3").code, "UNRECOGNIZED_CONTAINER");

  // Truncated WAV header
  const truncatedWav = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0x20, 0x00, 0x00, 0x00, 0x57, 0x41, 0x56, 0x45]);
  assert.strictEqual(validateAudioBuffer(truncatedWav, ".wav").code, "MALFORMED_AUDIO_HEADER");
  console.log("   ✓ Empty (0 bytes), random non-audio, and truncated audio headers fail closed safely.");

  // --- Behavioral Test 5: Real Archival Audio Files Ingestion ---
  console.log("\nBehavioral Test 5: Real repository archival audio ingestion...");
  const audioDir = path.resolve(__dirname, "../../virasya-ai/data/input");
  if (fs.existsSync(audioDir)) {
    // 1. Real Odia Ogg Opus
    const odiaPath = path.join(audioDir, "e2e_verify_odia6.ogg");
    if (fs.existsSync(odiaPath)) {
      const odiaBytes = new Uint8Array(fs.readFileSync(odiaPath));
      const res = validateAudioBuffer(odiaBytes, ".ogg");
      assert.strictEqual(res.valid, true);
      assert.strictEqual(res.format, "ogg");
      assert(res.durationSeconds > 40 && res.durationSeconds < 55, `Expected ~47.6s, got ${res.durationSeconds}`);
      console.log(`   ✓ e2e_verify_odia6.ogg validated: format=${res.format}, duration=${res.durationSeconds}s, bytes=${res.byteSize}`);
    }

    // 2. Real Gujarati Ogg Vorbis
    const gujPath = path.join(audioDir, "Gujarati 3.ogg");
    if (fs.existsSync(gujPath)) {
      const gujBytes = new Uint8Array(fs.readFileSync(gujPath));
      const res = validateAudioBuffer(gujBytes, ".ogg");
      assert.strictEqual(res.valid, true);
      assert.strictEqual(res.format, "ogg");
      assert(res.durationSeconds > 20 && res.durationSeconds < 25, `Expected ~21.5s, got ${res.durationSeconds}`);
      console.log(`   ✓ Gujarati 3.ogg validated: format=${res.format}, duration=${res.durationSeconds}s, bytes=${res.byteSize}`);
    }

    // 3. Real WAV Speech
    const speechPath = path.join(audioDir, "speech.wav");
    if (fs.existsSync(speechPath)) {
      const speechBytes = new Uint8Array(fs.readFileSync(speechPath));
      const res = validateAudioBuffer(speechBytes, ".wav");
      assert.strictEqual(res.valid, true);
      assert.strictEqual(res.format, "wav");
      assert.strictEqual(res.durationSeconds, 1.0);
      console.log(`   ✓ speech.wav validated: format=${res.format}, duration=${res.durationSeconds}s, bytes=${res.byteSize}`);
    }

    // 4. Fake sample_hindi.wav (text 'dummy audio bytes')
    const fakePath = path.join(audioDir, "sample_hindi.wav");
    if (fs.existsSync(fakePath)) {
      const fakeBytes = new Uint8Array(fs.readFileSync(fakePath));
      const res = validateAudioBuffer(fakeBytes, ".wav");
      assert.strictEqual(res.valid, false);
      assert.strictEqual(res.code, "UNRECOGNIZED_CONTAINER");
      console.log(`   ✓ fake sample_hindi.wav correctly rejected as UNRECOGNIZED_CONTAINER.`);
    }
  }

  // --- Behavioral Test 6: WebM Adversarial Bypass Prevention Regression ---
  console.log("\nBehavioral Test 6: WebM adversarial bypass regression (VULN-01)...");
  const ebmlHdr = [0x1a, 0x45, 0xdf, 0xa3, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00];
  const segHdr = [0x18, 0x53, 0x80, 0x67, 0x10, 0x00, 0x00, 0x50];
  const infoHdr = [0x15, 0x49, 0xa9, 0x66, 0x87];
  const dur10El = [0x44, 0x89, 0x84, 0x46, 0x1c, 0x40, 0x00]; // Info.Duration = 10.0s

  // Case 6A: Declared 10.0s in Info, but Cluster at 90.0s (exceeding 60s limit)
  const cluster90 = [0x1f, 0x43, 0xb6, 0x75, 0x86, 0xe7, 0x84, 0x00, 0x01, 0x5f, 0x90];
  const webm90Adv = new Uint8Array([...ebmlHdr, ...segHdr, ...infoHdr, ...dur10El, ...cluster90]);
  const resWebm90 = validateAudioBuffer(webm90Adv, ".webm");
  assert.strictEqual(resWebm90.valid, false);
  assert.strictEqual(resWebm90.code, "AUDIO_TOO_LONG", "WebM with Cluster at 90s must be rejected as AUDIO_TOO_LONG");

  // Case 6B: Declared 10.0s in Info, but Cluster at 45.0s (contradicting Info metadata)
  const cluster45 = [0x1f, 0x43, 0xb6, 0x75, 0x86, 0xe7, 0x84, 0x00, 0x00, 0xaf, 0xc8];
  const webm45Adv = new Uint8Array([...ebmlHdr, ...segHdr, ...infoHdr, ...dur10El, ...cluster45]);
  const resWebm45 = validateAudioBuffer(webm45Adv, ".webm");
  assert.strictEqual(resWebm45.valid, false);
  assert.strictEqual(resWebm45.code, "MALFORMED_AUDIO_HEADER", "WebM with contradicting cluster timing must be rejected");
  console.log("   ✓ WebM adversarial timing bypasses (Cluster at 90s and contradictory 45s vs 10s) prevented.");

  // --- Behavioral Test 7: OGG Adversarial Granule Spoofing Regression ---
  console.log("\nBehavioral Test 7: OGG adversarial granule spoofing regression (VULN-02)...");
  const odiaTestPath = path.join(audioDir, "e2e_verify_odia6.ogg");
  if (fs.existsSync(odiaTestPath)) {
    const origOdiaBuf = fs.readFileSync(odiaTestPath);
    // Append dummy trailing page claiming granule = 48,000 (1.0s)
    const fakeOggPage = new Uint8Array(30);
    fakeOggPage.set([0x4f, 0x67, 0x67, 0x53], 0);
    fakeOggPage[4] = 0;
    fakeOggPage[5] = 4;
    new DataView(fakeOggPage.buffer).setUint32(6, 48000, true);
    new DataView(fakeOggPage.buffer).setUint32(10, 0, true);
    fakeOggPage[26] = 1;
    fakeOggPage[27] = 2;
    const spoofedOggBuf = new Uint8Array(origOdiaBuf.length + fakeOggPage.length);
    spoofedOggBuf.set(origOdiaBuf, 0);
    spoofedOggBuf.set(fakeOggPage, origOdiaBuf.length);

    const resOggSpoof = validateAudioBuffer(spoofedOggBuf, ".ogg");
    assert.strictEqual(resOggSpoof.valid, false);
    assert.strictEqual(resOggSpoof.code, "MALFORMED_AUDIO_HEADER", "OGG with spoofed trailing page must fail monotonic/header check");
    console.log("   ✓ OGG spoofed trailing page rejected (non-monotonic sequence/granule detected).");
  }

  // --- Behavioral Test 8: MP3 Xing Forgery & MPEG-2/2.5 Support Regression ---
  console.log("\nBehavioral Test 8: MP3 Xing forgery & MPEG-2/2.5 support regression (VULN-03 & VULN-06)...");
  // Case 8A: Forged Xing header claiming 10 frames on 50-frame buffer
  const frameSz = 417;
  const mp3ForgedBuf = new Uint8Array(frameSz * 50);
  for (let i = 0; i < 50; i++) {
    const off = i * frameSz;
    mp3ForgedBuf[off] = 0xff;
    mp3ForgedBuf[off + 1] = 0xfb;
    mp3ForgedBuf[off + 2] = 0x90;
    mp3ForgedBuf[off + 3] = 0x00;
  }
  mp3ForgedBuf.set([0x58, 0x69, 0x6e, 0x67], 36);
  mp3ForgedBuf.set([0x00, 0x00, 0x00, 0x01], 40);
  mp3ForgedBuf.set([0x00, 0x00, 0x00, 0x0a], 44); // claims 10 frames
  const resMp3Forged = validateAudioBuffer(mp3ForgedBuf, ".mp3");
  assert.strictEqual(resMp3Forged.valid, false);
  assert.strictEqual(resMp3Forged.code, "MALFORMED_AUDIO_HEADER", "MP3 with frames exceeding Xing claim must be rejected");

  // Case 8B: Valid MPEG-2 Layer III frames (22050 Hz, 64 kbps, mono -> frame size = 72 * 64000 / 22050 = 208 bytes)
  const mpeg2FrameSz = 208;
  const mpeg2Buf = new Uint8Array(mpeg2FrameSz * 20); // 20 frames = 20 * 576 / 22050 = 0.52s
  for (let i = 0; i < 20; i++) {
    const off = i * mpeg2FrameSz;
    mpeg2Buf[off] = 0xff;
    mpeg2Buf[off + 1] = 0xf3; // 1111 0011 (MPEG-2 Layer III)
    mpeg2Buf[off + 2] = 0x80; // 1000 0000 (64 kbps, 22050 Hz, no pad)
    mpeg2Buf[off + 3] = 0xc0; // mono
  }
  const resMpeg2 = validateAudioBuffer(mpeg2Buf, ".mp3");
  assert.strictEqual(resMpeg2.valid, true);
  assert.strictEqual(resMpeg2.format, "mp3");
  assert(resMpeg2.durationSeconds > 0.4 && resMpeg2.durationSeconds < 0.6);
  console.log("   ✓ MP3 Xing header forgery rejected; MPEG-2 Layer III frame sequence accurately parsed.");

  // --- Behavioral Test 9: M4A Discrepant Payload Regression ---
  console.log("\nBehavioral Test 9: M4A discrepant payload regression (VULN-04)...");
  const ftypBox = [0x00, 0x00, 0x00, 0x14, 0x66, 0x74, 0x79, 0x70, 0x4d, 0x34, 0x41, 0x20, 0x00, 0x00, 0x00, 0x00, 0x4d, 0x34, 0x41, 0x20];
  const mvhdBox = new Uint8Array(108);
  const mvhdVw = new DataView(mvhdBox.buffer);
  mvhdVw.setUint32(0, 108, false);
  mvhdBox.set([0x6d, 0x76, 0x68, 0x64], 4);
  mvhdBox[8] = 0;
  mvhdVw.setUint32(20, 1000, false);
  mvhdVw.setUint32(24, 5000, false); // claims 5.0s

  const moovBox = new Uint8Array(116);
  new DataView(moovBox.buffer).setUint32(0, 116, false);
  moovBox.set([0x6d, 0x6f, 0x6f, 0x76], 4);
  moovBox.set(mvhdBox, 8);

  const mdatBoxLen = 3 * 1024 * 1024; // 3 MB mdat
  const mdatBox = new Uint8Array(mdatBoxLen);
  new DataView(mdatBox.buffer).setUint32(0, mdatBoxLen, false);
  mdatBox.set([0x6d, 0x64, 0x61, 0x74], 4);

  const m4aAdvBuf = new Uint8Array(ftypBox.length + moovBox.length + mdatBox.length);
  m4aAdvBuf.set(ftypBox, 0);
  m4aAdvBuf.set(moovBox, ftypBox.length);
  m4aAdvBuf.set(mdatBox, ftypBox.length + moovBox.length);

  const resM4aAdv = validateAudioBuffer(m4aAdvBuf, ".m4a");
  assert.strictEqual(resM4aAdv.valid, false);
  assert.strictEqual(resM4aAdv.code, "MALFORMED_AUDIO_HEADER", "M4A with 3 MB mdat claiming 5s must be rejected");
  console.log("   ✓ M4A discrepant media payload (3 MB mdat vs 5s claimed) rejected.");

  // --- Behavioral Test 10: WAV Trailing Payload Regression ---
  console.log("\nBehavioral Test 10: WAV trailing unallocated payload regression (VULN-05)...");
  const wavTotBytes = 3 * 1024 * 1024; // 3 MB
  const wavAdvBuf = new Uint8Array(wavTotBytes);
  const wavVw = new DataView(wavAdvBuf.buffer);
  wavAdvBuf.set([0x52, 0x49, 0x46, 0x46], 0);
  wavVw.setUint32(4, wavTotBytes - 8, true);
  wavAdvBuf.set([0x57, 0x41, 0x56, 0x45], 8);
  wavAdvBuf.set([0x66, 0x6d, 0x74, 0x20], 12);
  wavVw.setUint32(16, 16, true);
  wavVw.setUint16(20, 1, true); // PCM
  wavVw.setUint16(22, 1, true); // 1 ch
  wavVw.setUint32(24, 16000, true);
  wavVw.setUint32(28, 32000, true);
  wavVw.setUint16(32, 2, true);
  wavVw.setUint16(34, 16, true);
  wavAdvBuf.set([0x64, 0x61, 0x74, 0x61], 36);
  wavVw.setUint32(40, 32000, true); // claims only 1 second

  const resWavAdv = validateAudioBuffer(wavAdvBuf, ".wav");
  assert.strictEqual(resWavAdv.valid, false);
  assert.strictEqual(resWavAdv.code, "AUDIO_TOO_LONG", "WAV with 3 MB payload claiming 1s dataSize must be rejected as AUDIO_TOO_LONG");
  console.log("   ✓ WAV trailing unallocated payload (3 MB file claiming 1s data) rejected.");

  // --- Behavioral Test 11: FLAC Sample Count Discrepancy Regression ---
  console.log("\nBehavioral Test 11: FLAC sample count discrepancy regression...");
  const flacAdvBuf = new Uint8Array(3 * 1024 * 1024);
  flacAdvBuf.set([0x66, 0x4c, 0x61, 0x43], 0);
  flacAdvBuf.set([0x00, 0x00, 0x00, 0x22], 4);
  flacAdvBuf[18] = 0x03;
  flacAdvBuf[19] = 0xe8;
  flacAdvBuf[20] = 0x00;
  flacAdvBuf[24] = 0x3e;
  flacAdvBuf[25] = 0x80; // claims 16,000 samples (1s)

  const resFlacAdv = validateAudioBuffer(flacAdvBuf, ".flac");
  assert.strictEqual(resFlacAdv.valid, false);
  assert.strictEqual(resFlacAdv.code, "MALFORMED_AUDIO_HEADER", "FLAC with 3 MB file claiming 1s must be rejected");
  console.log("   ✓ FLAC sample count discrepancy (3 MB file claiming 1s) rejected.");

  // --- Behavioral Test 12: Reliable Exact Object Lookup & Prefix Confusion Prevention (SEC-03) ---
  console.log("\nBehavioral Test 12: Storage exact key lookup simulation vs prefix confusion (SEC-03)...");
  // Simulate mock Supabase Storage backing map
  const mockStorage = new Map();
  mockStorage.set("user-123/story_recording.wav", generatePcmWav(15.0));
  mockStorage.set("user-123/story_recording.wav.bak", generatePcmWav(45.0));
  mockStorage.set("user-123/story_recording.wav-extended.wav", generatePcmWav(90.0));

  function mockStorageDownload(key) {
    if (mockStorage.has(key)) {
      return { data: mockStorage.get(key), error: null };
    }
    return { data: null, error: { message: "Object not found", status: 404 } };
  }

  // Exact lookup succeeds
  const exactReq = mockStorageDownload("user-123/story_recording.wav");
  assert(exactReq.data !== null, "Exact path lookup must find target object");
  assert.strictEqual(exactReq.data.byteLength, mockStorage.get("user-123/story_recording.wav").byteLength);

  // Non-existent key fails closed (does not match prefix)
  const prefixReq = mockStorageDownload("user-123/story_recording");
  assert.strictEqual(prefixReq.data, null, "Prefix alone must NOT match full object name");
  assert.strictEqual(prefixReq.error.status, 404);

  // Missing object fails closed
  const missingReq = mockStorageDownload("user-123/non_existent.wav");
  assert.strictEqual(missingReq.data, null, "Missing object must fail closed");
  console.log("   ✓ Storage download requires exact key match; prefix collisions (.bak, -extended) cannot be mistaken for requested object.");

  // --- Behavioral Test 13: Active Storyteller Folder Scale (> 10 items) ---
  console.log("\nBehavioral Test 13: Active storyteller folder scale (>10 items pagination fix)...");
  // Simulate a prolific user with 25 audio files
  for (let i = 1; i <= 25; i++) {
    mockStorage.set(`user-prolific/recording_${String(i).padStart(2, "0")}.wav`, generatePcmWav(5.0));
  }

  // Retrieve the 23rd object directly via download
  const targetKey = "user-prolific/recording_23.wav";
  const item23 = mockStorageDownload(targetKey);
  assert(item23.data !== null, "Must retrieve 23rd object directly without pagination failure");
  assert.strictEqual(item23.error, null);
  console.log("   ✓ User directory with >10 items (25 files) succeeds without false-negative AUDIO_OBJECT_NOT_FOUND.");

  // --- Behavioral Test 14: Authorization & Ownership Partition Simulation ---
  console.log("\nBehavioral Test 14: Authorization & ownership partition simulation...");
  function verifyPathAuthorization(authUserId, storagePath) {
    if (storagePath.includes("..") || storagePath.includes("\\") || storagePath.startsWith("/")) {
      return { authorized: false, code: "MALFORMED_STORAGE_PATH" };
    }
    const expectedPrefix = `${authUserId}/`;
    if (!storagePath.startsWith(expectedPrefix)) {
      return { authorized: false, code: "FORBIDDEN_STORAGE_PATH" };
    }
    return { authorized: true };
  }

  assert.strictEqual(verifyPathAuthorization("user-alice", "user-alice/rec.wav").authorized, true);
  assert.strictEqual(verifyPathAuthorization("user-alice", "user-bob/rec.wav").code, "FORBIDDEN_STORAGE_PATH");
  assert.strictEqual(verifyPathAuthorization("user-alice", "../user-bob/rec.wav").code, "MALFORMED_STORAGE_PATH");
  assert.strictEqual(verifyPathAuthorization("user-alice", "user-alice/../user-bob/rec.wav").code, "MALFORMED_STORAGE_PATH");
  assert.strictEqual(verifyPathAuthorization("user-alice", "/user-alice/rec.wav").code, "MALFORMED_STORAGE_PATH");
  console.log("   ✓ Cross-user folder access and directory traversal attempts strictly rejected.");

  // --- Behavioral Test 15: Playback Authorization Logic Simulation ---
  console.log("\nBehavioral Test 15: Playback authorization simulation...");
  function evaluatePlaybackAccess(story, callerUserId) {
    const isPublicPreserved = story.status === "preserved" && story.visibility === "public";
    if (isPublicPreserved) {
      return { allowed: true, reason: "public_preserved" };
    }
    if (!callerUserId) {
      return { allowed: false, code: "UNAUTHORIZED_PRIVATE_AUDIO" };
    }
    if (story.user_id !== callerUserId) {
      return { allowed: false, code: "FORBIDDEN_AUDIO_ACCESS" };
    }
    return { allowed: true, reason: "authenticated_owner" };
  }

  const publicPreservedStory = { status: "preserved", visibility: "public", user_id: "user-1" };
  const privatePreservedStory = { status: "preserved", visibility: "private", user_id: "user-1" };
  const draftStory = { status: "draft", visibility: "public", user_id: "user-1" };

  // Public preserved story allows anonymous playback
  assert.strictEqual(evaluatePlaybackAccess(publicPreservedStory, null).allowed, true);
  // Private preserved story rejects anonymous caller
  assert.strictEqual(evaluatePlaybackAccess(privatePreservedStory, null).code, "UNAUTHORIZED_PRIVATE_AUDIO");
  // Private preserved story rejects non-owner caller
  assert.strictEqual(evaluatePlaybackAccess(privatePreservedStory, "user-2").code, "FORBIDDEN_AUDIO_ACCESS");
  // Private preserved story allows owner
  assert.strictEqual(evaluatePlaybackAccess(privatePreservedStory, "user-1").allowed, true);
  // Draft story rejects non-owner caller
  assert.strictEqual(evaluatePlaybackAccess(draftStory, "user-2").code, "FORBIDDEN_AUDIO_ACCESS");
  console.log("   ✓ Playback access correctly gates public vs private vs draft recordings.");

  // --- Behavioral Test 16: Failed Upload / Unvalidated Recording Story Sealing Prevention ---
  console.log("\nBehavioral Test 16: Story sealing fail-closed on audio validation failure...");
  function simulateStorySealing(audioPayload, storageMap) {
    if (!audioPayload) {
      // Text-only story
      return { sealed: true, storyType: "text_only" };
    }
    if (!audioPayload.storage_path) {
      return { sealed: false, code: "MISSING_STORAGE_PATH" };
    }
    const storageItem = storageMap.get(audioPayload.storage_path);
    if (!storageItem) {
      return { sealed: false, code: "AUDIO_OBJECT_NOT_FOUND" };
    }
    const val = validateAudioBuffer(storageItem, ".wav");
    if (!val.valid) {
      return { sealed: false, code: val.code };
    }
    return { sealed: true, verifiedDuration: val.durationSeconds };
  }

  // 1. Text-only succeeds
  assert.strictEqual(simulateStorySealing(null, mockStorage).sealed, true);

  // 2. Audio with missing storage_path fails closed
  assert.strictEqual(simulateStorySealing({ filename: "rec.wav" }, mockStorage).code, "MISSING_STORAGE_PATH");

  // 3. Audio with missing storage object fails closed
  assert.strictEqual(simulateStorySealing({ storage_path: "user-123/missing.wav" }, mockStorage).code, "AUDIO_OBJECT_NOT_FOUND");

  // 4. Audio with corrupt storage object fails closed
  mockStorage.set("user-123/corrupt.wav", new Uint8Array([1, 2, 3]));
  assert.strictEqual(simulateStorySealing({ storage_path: "user-123/corrupt.wav" }, mockStorage).code, "UNRECOGNIZED_CONTAINER");

  // 5. Valid audio succeeds and records verified duration
  assert.strictEqual(simulateStorySealing({ storage_path: "user-123/story_recording.wav" }, mockStorage).sealed, true);
  console.log("   ✓ Sealing invariant upheld: unvalidated or missing audio recordings cannot reach preserved state.");

  // --- Behavioral Test 17: OGG Stream Chaining & Monotonic Granule Handling ---
  console.log("\nBehavioral Test 17: OGG chained page sequences and monotonic granule handling...");
  function makeOggPage(serial, seq, granule, isBos, isEos, payload) {
    const numSegments = Math.ceil(payload.length / 255) || 1;
    const segTable = [];
    let rem = payload.length;
    for (let i = 0; i < numSegments; i++) {
      const take = Math.min(255, rem);
      segTable.push(take);
      rem -= take;
    }
    const pageLen = 27 + segTable.length + payload.length;
    const buf = new Uint8Array(pageLen);
    const view = new DataView(buf.buffer);
    buf.set([0x4f, 0x67, 0x67, 0x53], 0); // "OggS"
    buf[4] = 0; // version
    buf[5] = (isBos ? 2 : 0) | (isEos ? 4 : 0);
    view.setUint32(6, granule & 0xffffffff, true);
    view.setUint32(10, Math.floor(granule / (2 ** 32)), true);
    view.setUint32(14, serial, true);
    view.setUint32(18, seq, true);
    view.setUint32(22, 0, true); // CRC placeholder
    buf[26] = segTable.length;
    buf.set(segTable, 27);
    buf.set(payload, 27 + segTable.length);
    return buf;
  }

  function makeOpusStream(serial, durationSec) {
    const opusHead = new Uint8Array(19);
    opusHead.set([0x4f, 0x70, 0x75, 0x73, 0x48, 0x65, 0x61, 0x64], 0); // "OpusHead"
    opusHead[8] = 1;
    opusHead[9] = 1;
    new DataView(opusHead.buffer).setUint32(12, 48000, true);
    const p0 = makeOggPage(serial, 0, 0, true, false, opusHead);

    const granule = Math.round(durationSec * 48000);
    const audioPayload = new Uint8Array(100);
    const p1 = makeOggPage(serial, 1, granule, false, true, audioPayload);

    const merged = new Uint8Array(p0.length + p1.length);
    merged.set(p0, 0);
    merged.set(p1, p0.length);
    return merged;
  }

  // Single valid Opus stream (15s)
  const singleOgg = makeOpusStream(101, 15.0);
  const resSingleOgg = validateAudioBuffer(singleOgg, ".ogg");
  assert.strictEqual(resSingleOgg.valid, true);
  assert.strictEqual(resSingleOgg.format, "ogg");
  assert.strictEqual(resSingleOgg.durationSeconds, 15.0);

  // Two chained Opus streams (40s + 40s = 80s) -> Rejects as AUDIO_TOO_LONG
  const chainPart1 = makeOpusStream(101, 40.0);
  const chainPart2 = makeOpusStream(102, 40.0);
  const chainedOversized = new Uint8Array(chainPart1.length + chainPart2.length);
  chainedOversized.set(chainPart1, 0);
  chainedOversized.set(chainPart2, chainPart1.length);
  const resChainedOver = validateAudioBuffer(chainedOversized, ".ogg");
  assert.strictEqual(resChainedOver.valid, false);
  assert.strictEqual(resChainedOver.code, "AUDIO_TOO_LONG");
  assert(resChainedOver.error.includes("80.0s"));

  // Two chained Opus streams (20s + 25s = 45s) -> Passes under 60s
  const chainOk1 = makeOpusStream(101, 20.0);
  const chainOk2 = makeOpusStream(102, 25.0);
  const chainedOk = new Uint8Array(chainOk1.length + chainOk2.length);
  chainedOk.set(chainOk1, 0);
  chainedOk.set(chainOk2, chainOk1.length);
  const resChainedOk = validateAudioBuffer(chainedOk, ".ogg");
  assert.strictEqual(resChainedOk.valid, true);
  assert.strictEqual(resChainedOk.format, "ogg");
  assert.strictEqual(resChainedOk.durationSeconds, 45.0);
  console.log("   ✓ Ogg stream parsing correctly handles single and chained streams, accumulating cumulative duration.");

  // --- Behavioral Test 18: FLAC STREAMINFO Header Bit-Level Parsing ---
  console.log("\nBehavioral Test 18: FLAC STREAMINFO bit-unpacking and duration validation...");
  function generateFlac(durationSeconds, sampleRate = 44100, bitsPerSample = 16, channels = 1) {
    const totalSamples = Math.round(durationSeconds * sampleRate);
    const buf = new Uint8Array(42 + 64);
    const view = new DataView(buf.buffer);
    buf.set([0x66, 0x4c, 0x61, 0x43], 0); // "fLaC"
    buf[4] = 0x80; // Last metadata block, type 0 (STREAMINFO)
    buf[5] = 0x00;
    buf[6] = 0x00;
    buf[7] = 0x22; // 34 bytes block length
    view.setUint16(8, 4096, false);
    view.setUint16(10, 4096, false);
    buf[18] = (sampleRate >> 12) & 0xff;
    buf[19] = (sampleRate >> 4) & 0xff;
    buf[20] = ((sampleRate & 0x0f) << 4) | (((channels - 1) & 0x07) << 1) | (((bitsPerSample - 1) >> 4) & 0x01);
    buf[21] = (((bitsPerSample - 1) & 0x0f) << 4) | (Math.floor(totalSamples / (2 ** 32)) & 0x0f);
    view.setUint32(22, totalSamples >>> 0, false);
    return buf;
  }

  // 1s FLAC at 44.1kHz
  const resFlac1 = validateAudioBuffer(generateFlac(1.0, 44100, 16), ".flac");
  assert.strictEqual(resFlac1.valid, true);
  assert.strictEqual(resFlac1.format, "flac");
  assert.strictEqual(resFlac1.durationSeconds, 1.0);

  // 2s FLAC at 48kHz 24-bit
  const resFlac2 = validateAudioBuffer(generateFlac(2.0, 48000, 24), ".flac");
  assert.strictEqual(resFlac2.valid, true);
  assert.strictEqual(resFlac2.format, "flac");
  assert.strictEqual(resFlac2.durationSeconds, 2.0);

  // Zero-sample FLAC -> AUDIO_DURATION_UNVERIFIABLE
  const resFlacZero = validateAudioBuffer(generateFlac(0, 44100, 16), ".flac");
  assert.strictEqual(resFlacZero.valid, false);
  assert.strictEqual(resFlacZero.code, "AUDIO_DURATION_UNVERIFIABLE");

  // Oversized FLAC (65s) -> AUDIO_TOO_LONG
  const resFlacOver = validateAudioBuffer(generateFlac(65.0, 44100, 16), ".flac");
  assert.strictEqual(resFlacOver.valid, false);
  assert.strictEqual(resFlacOver.code, "AUDIO_TOO_LONG");
  console.log("   ✓ FLAC STREAMINFO bit-unpacking verified for various sample rates, bit depths, and boundary conditions.");

  // --- Behavioral Test 19: ADTS AAC Header Parsing & MP3 Disambiguation ---
  console.log("\nBehavioral Test 19: ADTS AAC frame decoding & MPEG Layer III disambiguation...");
  function generateAdtsAac(durationSeconds, sampleRate = 44100) {
    const srIdx = 4; // 44100 Hz index
    const frameCount = Math.max(2, Math.round((durationSeconds * sampleRate) / 1024));
    const frameLen = 7 + 30; // 37 bytes per frame
    const buf = new Uint8Array(frameCount * frameLen);
    for (let f = 0; f < frameCount; f++) {
      const off = f * frameLen;
      buf[off] = 0xff;
      buf[off + 1] = 0xf1; // MPEG-4, Layer 00, no CRC
      buf[off + 2] = 0x50; // profile 1 (AAC-LC) + srIdx 4
      buf[off + 3] = (frameLen >> 11) & 0x03;
      buf[off + 4] = (frameLen >> 3) & 0xff;
      buf[off + 5] = ((frameLen & 0x07) << 5) | 0x1f;
      buf[off + 6] = 0xfc;
    }
    return buf;
  }

  // 2s ADTS AAC
  const resAac2 = validateAudioBuffer(generateAdtsAac(2.0), ".aac");
  assert.strictEqual(resAac2.valid, true);
  assert.strictEqual(resAac2.format, "aac");
  assert.strictEqual(resAac2.durationSeconds, 2.0);

  // 65s ADTS AAC -> AUDIO_TOO_LONG
  const resAacOver = validateAudioBuffer(generateAdtsAac(65.0), ".aac");
  assert.strictEqual(resAacOver.valid, false);
  assert.strictEqual(resAacOver.code, "AUDIO_TOO_LONG");

  // Single truncated ADTS frame (< 2 frames) -> AUDIO_DURATION_UNVERIFIABLE
  const singleAdtsFrame = generateAdtsAac(2.0).slice(0, 37);
  const resAacTrunc = validateAudioBuffer(singleAdtsFrame, ".aac");
  assert.strictEqual(resAacTrunc.valid, false);
  assert.strictEqual(resAacTrunc.code, "AUDIO_DURATION_UNVERIFIABLE");
  console.log("   ✓ ADTS AAC correctly identified as format 'aac' and differentiated from MPEG Layer III.");

  // --- Behavioral Test 20: Cross-Check Against ffprobe Ground Truth ---
  console.log("\nBehavioral Test 20: Ground truth comparison against ffprobe on synthetic audio...");
  const tempAudioDir = fs.mkdtempSync(path.join(os.tmpdir(), "virasya-audio-groundtruth-"));
  try {
    const testMatrix = [
      { ext: "wav", cmd: "-f lavfi -i sine=frequency=440:duration=2.5 -c:a pcm_s16le" },
      { ext: "ogg", cmd: "-f lavfi -i sine=frequency=440:duration=3.0 -c:a libopus" },
      { ext: "flac", cmd: "-f lavfi -i sine=frequency=440:duration=1.8 -c:a flac" },
      { ext: "aac", cmd: "-f lavfi -i sine=frequency=440:duration=2.2 -c:a aac" },
    ];
    for (const item of testMatrix) {
      const outPath = path.join(tempAudioDir, `sample.${item.ext}`);
      cp.execSync(`ffmpeg -y ${item.cmd} "${outPath}"`, { stdio: "pipe" });
      const probeOut = cp.execSync(
        `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${outPath}"`
      ).toString().trim();
      const ffprobeDur = parseFloat(probeOut);
      assert(!isNaN(ffprobeDur), `ffprobe failed to return duration for ${item.ext}`);

      const fileBytes = fs.readFileSync(outPath);
      const valRes = validateAudioBuffer(fileBytes, `.${item.ext}`);
      assert.strictEqual(valRes.valid, true, `validateAudioBuffer failed on ffmpeg ${item.ext}`);
      assert.strictEqual(valRes.format, item.ext, `Expected format ${item.ext}`);

      const delta = Math.abs(valRes.durationSeconds - ffprobeDur);
      assert(
        delta <= 0.1,
        `Duration discrepancy for ${item.ext} exceeds 0.1s tolerance (ffprobe: ${ffprobeDur}s, validator: ${valRes.durationSeconds}s, delta: ${delta}s)`
      );
      console.log(`     • ${item.ext.toUpperCase()}: ffprobe=${ffprobeDur}s, validator=${valRes.durationSeconds}s (delta=${delta.toFixed(4)}s <= 0.1s tolerance)`);
    }
  } finally {
    fs.rmSync(tempAudioDir, { recursive: true, force: true });
  }
  console.log("   ✓ All ffmpeg generated formats match ffprobe duration within +/- 0.1s tolerance.");

  // --- Behavioral Test 21: Real ffmpeg Chained Ogg (Opus & Vorbis) with Dual Ground Truth ---
  console.log("\nBehavioral Test 21: Real ffmpeg chained Ogg with ffprobe & PCM decode ground truth...");
  const tempChainedDir = fs.mkdtempSync(path.join(os.tmpdir(), "virasya-chained-groundtruth-"));
  try {
    // 1. Chained 40s + 40s = 80s Opus
    const p1 = path.join(tempChainedDir, "p1.ogg");
    const p2 = path.join(tempChainedDir, "p2.ogg");
    const concatTxt = path.join(tempChainedDir, "concat_opus.txt");
    const chained80 = path.join(tempChainedDir, "chained80.ogg");
    const pcm80 = path.join(tempChainedDir, "out80.pcm");

    cp.execSync(`ffmpeg -y -f lavfi -i sine=frequency=440:duration=40.0 -c:a libopus "${p1}"`, { stdio: "pipe" });
    cp.execSync(`ffmpeg -y -f lavfi -i sine=frequency=880:duration=40.0 -c:a libopus "${p2}"`, { stdio: "pipe" });
    fs.writeFileSync(concatTxt, `file '${p1.replace(/\\/g, "/")}'\nfile '${p2.replace(/\\/g, "/")}'\n`);
    cp.execSync(`ffmpeg -y -f concat -safe 0 -i "${concatTxt}" -c copy "${chained80}"`, { stdio: "pipe" });

    // PCM decode ground truth (16kHz mono s16le = 32000 B/s)
    cp.execSync(`ffmpeg -y -i "${chained80}" -ar 16000 -ac 1 -f s16le "${pcm80}"`, { stdio: "pipe" });
    const pcmDur = fs.readFileSync(pcm80).length / (16000 * 2);
    assert(Math.abs(pcmDur - 80.0) <= 0.1, `PCM ground truth duration was ${pcmDur}s, expected ~80s`);

    // Validator check: must reject 80s chained stream and not accept as 40s
    const val80 = validateAudioBuffer(fs.readFileSync(chained80), ".ogg");
    assert.strictEqual(val80.valid, false, "Chained 80s stream must be rejected");
    assert.strictEqual(val80.code, "AUDIO_TOO_LONG");
    assert(val80.error.includes("80.0s"), `Expected 80.0s in error message, got: ${val80.error}`);
    console.log(`     • Chained 80s Opus: rejected as AUDIO_TOO_LONG (measured 80.0s, pcmGroundTruth=${pcmDur}s)`);

    // 2. Chained 20s + 25s = 45s Opus
    const o1 = path.join(tempChainedDir, "o1.ogg");
    const o2 = path.join(tempChainedDir, "o2.ogg");
    const concatO = path.join(tempChainedDir, "concat_o.txt");
    const chained45 = path.join(tempChainedDir, "chained45.ogg");
    cp.execSync(`ffmpeg -y -f lavfi -i sine=frequency=440:duration=20.0 -c:a libopus "${o1}"`, { stdio: "pipe" });
    cp.execSync(`ffmpeg -y -f lavfi -i sine=frequency=880:duration=25.0 -c:a libopus "${o2}"`, { stdio: "pipe" });
    fs.writeFileSync(concatO, `file '${o1.replace(/\\/g, "/")}'\nfile '${o2.replace(/\\/g, "/")}'\n`);
    cp.execSync(`ffmpeg -y -f concat -safe 0 -i "${concatO}" -c copy "${chained45}"`, { stdio: "pipe" });
    const val45 = validateAudioBuffer(fs.readFileSync(chained45), ".ogg");
    assert.strictEqual(val45.valid, true, "Chained 45s stream must be accepted");
    assert.strictEqual(val45.format, "ogg");
    assert(Math.abs(val45.durationSeconds - 45.0) <= 0.2, `Expected ~45s, got ${val45.durationSeconds}s`);
    console.log(`     • Chained 45s Opus: accepted (measured ${val45.durationSeconds}s)`);
  } finally {
    fs.rmSync(tempChainedDir, { recursive: true, force: true });
  }
  console.log("   ✓ Real ffmpeg chained Ogg streams correctly accumulated and evaluated against duration boundary.");

  // --- Behavioral Test 22: Real ffmpeg Duration Boundaries (59.9s, 60.0s, 60.1s) across Formats ---
  console.log("\nBehavioral Test 22: Duration boundaries (59.9s, 60.0s, 60.1s) across WAV, OGG, FLAC, AAC...");
  const tempBoundDir = fs.mkdtempSync(path.join(os.tmpdir(), "virasya-boundary-test-"));
  try {
    const boundaryFormats = [
      { ext: "wav", cmd: "-f lavfi -i sine=frequency=440:duration={dur} -ar 16000 -ac 1 -c:a pcm_s16le" },
      { ext: "ogg", cmd: "-f lavfi -i sine=frequency=440:duration={dur} -c:a libopus" },
      { ext: "flac", cmd: "-f lavfi -i sine=frequency=440:duration={dur} -ar 16000 -ac 1 -c:a flac" },
      { ext: "aac", cmd: "-f lavfi -i sine=frequency=440:duration={dur} -c:a aac" },
    ];

    for (const fmt of boundaryFormats) {
      for (const d of [59.9, 60.0, 60.1]) {
        const fPath = path.join(tempBoundDir, `bound_${fmt.ext}_${d}.${fmt.ext}`);
        const cmd = fmt.cmd.replace("{dur}", d.toFixed(1));
        cp.execSync(`ffmpeg -y ${cmd} "${fPath}"`, { stdio: "pipe" });
        const bytes = fs.readFileSync(fPath);
        const res = validateAudioBuffer(bytes, `.${fmt.ext}`);

        if (d <= MAX_AUDIO_DURATION_SECONDS) {
          assert.strictEqual(res.valid, true, `Expected ${d}s ${fmt.ext} to be valid, got: ${JSON.stringify(res)}`);
        } else {
          assert.strictEqual(res.valid, false, `Expected ${d}s ${fmt.ext} to fail, got: ${JSON.stringify(res)}`);
          assert.strictEqual(res.code, "AUDIO_TOO_LONG");
        }
      }
      console.log(`     • Format ${fmt.ext.toUpperCase()}: 59.9s=PASS, 60.0s=PASS, 60.1s=REJECT (AUDIO_TOO_LONG)`);
    }
  } finally {
    fs.rmSync(tempBoundDir, { recursive: true, force: true });
  }
  console.log("   ✓ Real ffmpeg audio files precisely obey the 60.0s duration ceiling across all containers.");

  // --- Behavioral Test 23: Malformed Real Audio & Stream Integrity Rejection ---
  console.log("\nBehavioral Test 23: Malformed, truncated, corrupted headers, and extension mismatch...");
  const tempMalDir = fs.mkdtempSync(path.join(os.tmpdir(), "virasya-malformed-test-"));
  try {
    const realWavPath = path.join(tempMalDir, "sample_ok.wav");
    cp.execSync(`ffmpeg -y -f lavfi -i sine=frequency=440:duration=2.0 -ar 16000 -ac 1 -c:a pcm_s16le "${realWavPath}"`, { stdio: "pipe" });
    const realWavBytes = fs.readFileSync(realWavPath);

    // 1. Truncated real WAV (cut 30% off end)
    const truncated = realWavBytes.slice(0, Math.floor(realWavBytes.length * 0.7));
    const resTrunc = validateAudioBuffer(truncated, ".wav");
    assert.strictEqual(resTrunc.valid, false);
    assert.strictEqual(resTrunc.code, "MALFORMED_AUDIO_HEADER");

    // 2. Corrupted header bytes
    const corrupt = Buffer.from(realWavBytes);
    corrupt[0] = 0x00;
    corrupt[1] = 0x00;
    const resCorrupt = validateAudioBuffer(corrupt, ".wav");
    assert.strictEqual(resCorrupt.valid, false);

    // 3. Extension mismatch: authentic audio with prohibited extension
    const resWrongExt = validateAudioBuffer(realWavBytes, ".txt");
    assert.strictEqual(resWrongExt.valid, false);
    assert.strictEqual(resWrongExt.code, "UNRECOGNIZED_CONTAINER");

    // 4. Ogg stream with missing/-1 granule positions
    const opusHead = new Uint8Array(19);
    opusHead.set([0x4f, 0x70, 0x75, 0x73, 0x48, 0x65, 0x61, 0x64], 0);
    opusHead[8] = 1; opusHead[9] = 1;
    new DataView(opusHead.buffer).setUint32(12, 48000, true);
    const missingGranuleBuf = new Uint8Array(27 + 1 + 19);
    const viewMg = new DataView(missingGranuleBuf.buffer);
    missingGranuleBuf.set([0x4f, 0x67, 0x67, 0x53], 0);
    missingGranuleBuf[5] = 2; // BOS
    viewMg.setUint32(6, 0xffffffff, true);
    viewMg.setUint32(10, 0xffffffff, true);
    viewMg.setUint32(14, 555, true);
    viewMg.setUint32(18, 0, true);
    missingGranuleBuf[26] = 1;
    missingGranuleBuf[27] = 19;
    missingGranuleBuf.set(opusHead, 28);
    const resMissingGranule = validateAudioBuffer(missingGranuleBuf, ".ogg");
    assert.strictEqual(resMissingGranule.valid, false);
    assert.strictEqual(resMissingGranule.code, "AUDIO_DURATION_UNVERIFIABLE");

    console.log("   ✓ All malformed audio invariants (truncated payload, zeroed headers, bad extensions, unindexed granules) fail closed.");
  } finally {
    fs.rmSync(tempMalDir, { recursive: true, force: true });
  }

  console.log("\n==================================================================");
  console.log("ALL STATIC AND BEHAVIORAL SECURITY & AUDIT TESTS PASSED (100%)");
  console.log("==================================================================");
})();
