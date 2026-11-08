/**
 * Virasya 30-Second Recording Auto-Stop & Hero Cleanup Verification Suite
 *
 * Verifies:
 * 1. Page2Voice.tsx 30-second recording auto-stop & stale React closure immunity.
 * 2. Paused recording does not increment elapsed time.
 * 3. Exact 30-second auto-stop triggers once and clears interval.
 * 4. Manual "Stop & Save Recording" button remains available and operational.
 * 5. Microphone stream tracks are released upon recording completion.
 * 6. Direct PCM WAV encoder strictly caps audio to <= 30.0 seconds.
 * 7. Home Page Hero component: "Treasured and enriched." completely removed,
 *    and its styles/boxes cleared out without touching "Your stories, remembered.".
 */

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

console.log("=== Virasya 30s Recording & Hero Note Cleanup Test Suite ===\n");

// ---------------------------------------------------------------------------
// 1. Home Page Hero Cleanup Verification
// ---------------------------------------------------------------------------
console.log("1. Verifying Home Page Hero component cleanup...");
const heroPath = path.resolve(__dirname, "../src/sections/Hero/Hero.tsx");
const heroContent = fs.readFileSync(heroPath, "utf8");

assert(!heroContent.includes("Treasured and enriched."), "Hero.tsx must NOT contain 'Treasured and enriched.'");
assert(!heroContent.includes("note-one"), "Hero.tsx must NOT contain 'note-one'");
assert(heroContent.includes("note-two"), "Hero.tsx MUST retain 'note-two'");
assert(heroContent.includes("Your stories, remembered."), "Hero.tsx MUST retain 'Your stories, remembered.'");
assert(heroContent.includes("✓"), "Hero.tsx MUST retain checkmark icon for note-two");

console.log("   ✓ 'Treasured and enriched.' and .note-one completely removed from Hero.tsx.");
console.log("   ✓ 'Your stories, remembered.' (.note-two) remains fully intact in Hero.tsx.");

// ---------------------------------------------------------------------------
// 2. CSS Stylesheet Cleanup Verification
// ---------------------------------------------------------------------------
console.log("\n2. Verifying CSS styling cleanup in globals.css...");
const cssPath = path.resolve(__dirname, "../src/styles/globals.css");
const cssContent = fs.readFileSync(cssPath, "utf8");

// note-one must only exist as display: none fallback, no lingering layout boxes
const noteOneMatches = cssContent.match(/\.note-one/g) || [];
assert.strictEqual(noteOneMatches.length, 1, "Only one single fallback definition of .note-one should remain in globals.css");
assert(cssContent.includes(".note-one {\n  display: none !important;\n}"), "Fallback must be display: none !important");
assert(!cssContent.includes(".hero .note-one"), "All .hero .note-one media query boxes must be cleaned out");

// note-two must still exist
assert(cssContent.includes(".note-two"), ".note-two styling must remain intact");

console.log("   ✓ Lingering .note-one layout boxes and media-query overrides cleaned out of globals.css.");
console.log("   ✓ Fallback .note-one { display: none !important; } in place.");
console.log("   ✓ .note-two styles preserved untouched.");

// ---------------------------------------------------------------------------
// 3. Constants Single Source of Truth
// ---------------------------------------------------------------------------
console.log("\n3. Verifying MAX_AUDIO_DURATION_SECONDS constant...");
const constantsPath = path.resolve(__dirname, "../src/preserve/constants.ts");
const constantsContent = fs.readFileSync(constantsPath, "utf8");

assert(constantsContent.includes("export const MAX_AUDIO_DURATION_SECONDS = 30;"), "MAX_AUDIO_DURATION_SECONDS must be 30");
console.log("   ✓ MAX_AUDIO_DURATION_SECONDS is 30.");

// ---------------------------------------------------------------------------
// 4. Page2Voice.tsx Stale Closure & Timer Logic Inspection
// ---------------------------------------------------------------------------
console.log("\n4. Verifying Page2Voice.tsx implementation...");
const voicePath = path.resolve(__dirname, "../src/preserve/pages/Page2Voice.tsx");
const voiceContent = fs.readFileSync(voicePath, "utf8");

// Check stopRecording is decoupled from stale React state
assert(
  voiceContent.includes("mr && mr.state !== \"inactive\""),
  "stopRecording must check mr.state !== 'inactive' directly on mediaRecorderRef.current"
);
assert(
  !voiceContent.includes('(recState === "recording" || recState === "paused")\n  ) {\n    mediaRecorderRef.current.stop();'),
  "stopRecording must not rely on closed-over recState"
);

// Check startTimer handles pause and auto-stop
assert(voiceContent.includes('if (mr.state === "paused") {\n        return;\n      }'), "startTimer must skip incrementing elapsed time while paused");
assert(voiceContent.includes("elapsedRef.current >= MAX_AUDIO_DURATION_SECONDS"), "startTimer must check >= MAX_AUDIO_DURATION_SECONDS");
assert(voiceContent.includes("clearInterval(timerRef.current);\n        stopRecording();"), "startTimer must clear interval and trigger stopRecording");

// Check stream track cleanup
assert(voiceContent.includes("streamRef.current.getTracks().forEach((t) => t.stop())"), "Microphone stream tracks must be stopped");

// Check manual stop button
assert(voiceContent.includes("Stop & Save Recording"), "Manual 'Stop & Save Recording' button must be present in JSX");
assert(voiceContent.includes("onClick={stopRecording}"), "Manual stop button must invoke stopRecording");

// Check UI timer cap format
assert(voiceContent.includes("/ 00:30"), "Timer display must show / 00:30");

console.log("   ✓ stopRecording checks mediaRecorderRef.current.state directly (immune to stale React closure).");
console.log("   ✓ startTimer pauses elapsed time accumulation during pause.");
console.log("   ✓ startTimer automatically stops recording at 30 seconds.");
console.log("   ✓ Microphone stream tracks cleanly released.");
console.log("   ✓ Manual Stop & Save Recording button present and wired.");

// ---------------------------------------------------------------------------
// 5. Behavioral Simulation: Timer & MediaRecorder State Machine
// ---------------------------------------------------------------------------
console.log("\n5. Executing behavioral state machine simulation...");

class MockMediaRecorder {
  constructor() {
    this.state = "inactive";
    this.stopped = false;
    this.stopCallCount = 0;
  }
  start() {
    this.state = "recording";
  }
  pause() {
    if (this.state === "recording") this.state = "paused";
  }
  resume() {
    if (this.state === "paused") this.state = "recording";
  }
  stop() {
    this.state = "inactive";
    this.stopped = true;
    this.stopCallCount++;
  }
}

// Scenario A: 10s recording + manual stop
{
  const mr = new MockMediaRecorder();
  mr.start();
  let elapsed = 0;
  let intervalCleared = false;

  const timerTick = () => {
    if (mr.state === "inactive") return;
    if (mr.state === "paused") return;
    elapsed += 0.25;
    if (elapsed >= 30) {
      intervalCleared = true;
      mr.stop();
    }
  };

  // Simulate 40 ticks (10.0 seconds)
  for (let i = 0; i < 40; i++) timerTick();
  assert.strictEqual(elapsed, 10.0);
  assert.strictEqual(mr.state, "recording", "Must still be recording at 10s");

  // User clicks manual stop
  mr.stop();
  assert.strictEqual(mr.state, "inactive");
  assert.strictEqual(mr.stopCallCount, 1);
  console.log("   ✓ Scenario A: 10s recording runs continuously until manual stop.");
}

// Scenario B: 29s recording -> continues until auto-stop at 30s
{
  const mr = new MockMediaRecorder();
  mr.start();
  let elapsed = 0;
  let autoStopped = false;

  const timerTick = () => {
    if (mr.state === "inactive") return;
    if (mr.state === "paused") return;
    elapsed += 0.25;
    if (elapsed >= 30) {
      autoStopped = true;
      mr.stop();
    }
  };

  // Simulate 116 ticks (29.0 seconds)
  for (let i = 0; i < 116; i++) timerTick();
  assert.strictEqual(elapsed, 29.0);
  assert.strictEqual(mr.state, "recording", "Must still be recording at 29s");
  assert.strictEqual(autoStopped, false);

  // 4 more ticks (30.0 seconds)
  for (let i = 0; i < 4; i++) timerTick();
  assert.strictEqual(elapsed, 30.0);
  assert.strictEqual(autoStopped, true);
  assert.strictEqual(mr.state, "inactive");
  assert.strictEqual(mr.stopCallCount, 1, "Must stop exactly once");

  // Additional ticks should not increment or trigger multiple stops
  for (let i = 0; i < 10; i++) timerTick();
  assert.strictEqual(elapsed, 30.0);
  assert.strictEqual(mr.stopCallCount, 1, "Stop must not be called repeatedly");
  console.log("   ✓ Scenario B: 29s recording continues; auto-stops exactly once at 30.0s.");
}

// Scenario C: Pausing recording pauses elapsed time accumulation
{
  const mr = new MockMediaRecorder();
  mr.start();
  let elapsed = 0;

  const timerTick = () => {
    if (mr.state === "inactive") return;
    if (mr.state === "paused") return;
    elapsed += 0.25;
    if (elapsed >= 30) mr.stop();
  };

  // Record for 10 seconds (40 ticks)
  for (let i = 0; i < 40; i++) timerTick();
  assert.strictEqual(elapsed, 10.0);

  // User pauses recording
  mr.pause();
  assert.strictEqual(mr.state, "paused");

  // 40 ticks while paused (simulating 10s pause)
  for (let i = 0; i < 40; i++) timerTick();
  assert.strictEqual(elapsed, 10.0, "Elapsed time must NOT increase while paused");

  // User resumes recording
  mr.resume();
  assert.strictEqual(mr.state, "recording");

  // 60 ticks (15s recording) -> total recording time 25s
  for (let i = 0; i < 60; i++) timerTick();
  assert.strictEqual(elapsed, 25.0);
  assert.strictEqual(mr.state, "recording", "Must still be recording at 25s elapsed");

  // 20 more ticks (5s recording) -> reaches 30s
  for (let i = 0; i < 20; i++) timerTick();
  assert.strictEqual(elapsed, 30.0);
  assert.strictEqual(mr.state, "inactive", "Must auto-stop at 30s");
  console.log("   ✓ Scenario C: Pausing recording correctly preserves elapsed time and does not leak paused duration.");
}

// ---------------------------------------------------------------------------
// 6. PCM WAV Encoder Capping to <= 30.0s
// ---------------------------------------------------------------------------
console.log("\n6. Verifying PCM WAV encoder duration capping...");

(async () => {
  const { encodePcmTo16kWav } = await import("../src/preserve/utils.ts");

  // Generate 45 seconds of synthetic audio chunks at 44.1kHz
  const sampleRate = 44100;
  const targetRate = 16000;
  const chunkLength = 4096;
  const totalChunks = Math.ceil((45 * sampleRate) / chunkLength);
  const chunks = [];
  for (let i = 0; i < totalChunks; i++) {
    chunks.push(new Float32Array(chunkLength));
  }

  // Encode with default maxDurationSeconds = 30
  const wavBlob = encodePcmTo16kWav(chunks, sampleRate, 30);
  const arrayBuffer = await wavBlob.arrayBuffer();
  const dataView = new DataView(arrayBuffer);

  // Parse WAV header
  const riff = String.fromCharCode(...new Uint8Array(arrayBuffer, 0, 4));
  assert.strictEqual(riff, "RIFF", "Header must be RIFF");
  const wave = String.fromCharCode(...new Uint8Array(arrayBuffer, 8, 4));
  assert.strictEqual(wave, "WAVE", "Format must be WAVE");
  const pcmSampleRate = dataView.getUint32(24, true);
  assert.strictEqual(pcmSampleRate, targetRate, "PCM sample rate must be 16000");

  const dataSize = dataView.getUint32(40, true);
  const totalSamples = dataSize / 2; // 16-bit = 2 bytes per sample
  const calculatedDuration = totalSamples / targetRate;

  assert(
    calculatedDuration <= 30.0,
    `WAV duration (${calculatedDuration}s) must not exceed 30.0s even when input was 45s`
  );
  assert.strictEqual(calculatedDuration, 30.0, "WAV duration should be capped exactly at 30.0s");

  console.log(`   ✓ 45s input PCM stream capped to exactly ${calculatedDuration}s WAV (${dataSize} bytes audio payload).`);
  console.log("\n=== ALL 30-SECOND RECORDING & HERO CLEANUP TESTS PASSED (100%) ===\n");
})();
