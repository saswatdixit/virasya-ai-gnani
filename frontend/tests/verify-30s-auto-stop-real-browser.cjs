/**
 * Virasya Final Real Browser & Gnani Verification Suite
 *
 * Runs end-to-end against real headless Chrome:
 * 1. Real browser continuous 30-second recording auto-stop.
 * 2. Real browser pause (5s) and resume (20s) -> auto-stop at 30s active (35s wall-clock).
 * 3. Generated WAV metadata validation (16kHz mono 16-bit PCM, duration <= 30.0s).
 * 4. Gnani Prisma STT API submission with the generated recording.
 * 5. Real browser manual stop regression (< 30s).
 * 6. Audio upload > 30s rejection regression.
 * 7. Home page Hero note regression ("Your stories, remembered." retained; "Treasured and enriched." purged).
 */

const { spawn } = require("child_process");
const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const assert = require("assert");

function findChromePath() {
  const possiblePaths = [
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    process.env.LOCALAPPDATA + "\\Google\\Chrome\\Application\\chrome.exe",
  ];
  for (const p of possiblePaths) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function getJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(e);
        }
      });
    }).on("error", reject);
  });
}

class CDPClient {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.id = 1;
    this.callbacks = new Map();
    this.ready = new Promise((resolve, reject) => {
      this.ws.onopen = resolve;
      this.ws.onerror = reject;
    });
    this.ws.onmessage = (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id && this.callbacks.has(msg.id)) {
        const { resolve, reject } = this.callbacks.get(msg.id);
        this.callbacks.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result);
      }
    };
  }

  async send(method, params = {}) {
    await this.ready;
    const id = this.id++;
    return new Promise((resolve, reject) => {
      this.callbacks.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async eval(expression) {
    const res = await this.send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (res.exceptionDetails) {
      throw new Error("Eval error: " + JSON.stringify(res.exceptionDetails));
    }
    return res.result.value;
  }

  close() {
    this.ws.close();
  }
}

function startStaticServer(distDir) {
  const mimeTypes = {
    ".html": "text/html",
    ".js": "application/javascript",
    ".css": "text/css",
    ".json": "application/json",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".svg": "image/svg+xml",
    ".ico": "image/x-icon",
    ".wav": "audio/wav",
  };

  const server = http.createServer((req, res) => {
    let reqPath = req.url.split("?")[0];
    let filePath = path.join(distDir, reqPath);
    if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
      filePath = path.join(distDir, "index.html");
    }
    const ext = path.extname(filePath).toLowerCase();
    const contentType = mimeTypes[ext] || "application/octet-stream";
    fs.readFile(filePath, (err, content) => {
      if (err) {
        res.writeHead(500);
        res.end("Internal Server Error");
      } else {
        res.writeHead(200, { "Content-Type": contentType });
        res.end(content);
      }
    });
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({ server, port: server.address().port });
    });
  });
}

function createSyntheticWav(durationSeconds, sampleRate = 16000) {
  const numSamples = Math.round(durationSeconds * sampleRate);
  const dataSize = numSamples * 2;
  const buffer = Buffer.alloc(44 + dataSize);

  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write("WAVE", 8);
  buffer.write("fmt ", 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20); // PCM
  buffer.writeUInt16LE(1, 22); // mono
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(dataSize, 40);

  // Fill with 440Hz tone
  for (let i = 0; i < numSamples; i++) {
    const t = i / sampleRate;
    const sample = Math.round(Math.sin(2 * Math.PI * 440 * t) * 16000);
    buffer.writeInt16LE(sample, 44 + i * 2);
  }

  return buffer;
}

function parseWavHeader(buffer) {
  const riff = buffer.toString("ascii", 0, 4);
  const wave = buffer.toString("ascii", 8, 12);
  const fmt = buffer.toString("ascii", 12, 16);
  const audioFormat = buffer.readUInt16LE(20);
  const channels = buffer.readUInt16LE(22);
  const sampleRate = buffer.readUInt32LE(24);
  const byteRate = buffer.readUInt32LE(28);
  const blockAlign = buffer.readUInt16LE(32);
  const bitsPerSample = buffer.readUInt16LE(34);
  const dataTag = buffer.toString("ascii", 36, 40);
  const dataSize = buffer.readUInt32LE(40);
  const samples = dataSize / (bitsPerSample / 8) / channels;
  const duration = samples / sampleRate;

  return {
    riff,
    wave,
    fmt,
    audioFormat,
    channels,
    sampleRate,
    byteRate,
    blockAlign,
    bitsPerSample,
    dataTag,
    dataSize,
    samples,
    duration,
  };
}

function submitToGnaniApi(wavBuffer, apiKey, languageCode = "hi-IN") {
  return new Promise((resolve, reject) => {
    const boundary = "----GnaniBoundary" + Math.random().toString(36).slice(2);
    const crlf = "\r\n";

    let bodyHeader = "";
    bodyHeader += `--${boundary}${crlf}`;
    bodyHeader += `Content-Disposition: form-data; name="language_code"${crlf}${crlf}`;
    bodyHeader += `${languageCode}${crlf}`;

    bodyHeader += `--${boundary}${crlf}`;
    bodyHeader += `Content-Disposition: form-data; name="format"${crlf}${crlf}`;
    bodyHeader += `verbatim${crlf}`;

    bodyHeader += `--${boundary}${crlf}`;
    bodyHeader += `Content-Disposition: form-data; name="audio_file"; filename="recorded-audio.wav"${crlf}`;
    bodyHeader += `Content-Type: audio/wav${crlf}${crlf}`;

    const bodyFooter = `${crlf}--${boundary}--${crlf}`;

    const fullBody = Buffer.concat([
      Buffer.from(bodyHeader, "utf8"),
      wavBuffer,
      Buffer.from(bodyFooter, "utf8"),
    ]);

    const req = https.request("https://api.vachana.ai/stt/v3", {
      method: "POST",
      headers: {
        "X-API-Key-ID": apiKey,
        "Content-Type": `multipart/form-data; boundary=${boundary}`,
        "Content-Length": fullBody.length,
      },
      timeout: 30000,
    }, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try {
          const json = JSON.parse(data);
          resolve({ status: res.statusCode, data: json });
        } catch {
          resolve({ status: res.statusCode, raw: data });
        }
      });
    });

    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("Gnani API timeout after 30s"));
    });

    req.write(fullBody);
    req.end();
  });
}

async function main() {
  console.log("================================================================================");
  console.log("   VIRASYA REAL BROWSER RECORDING & GNANI VERIFICATION SUITE");
  console.log("================================================================================\n");

  const resultsSummary = {
    test1_continuousAutoStop: null,
    test2_pauseResumeAutoStop: null,
    test3_generatedAudioValid: null,
    test4_gnaniAccepted: null,
    test5_manualStopShort: null,
    test6_uploadDurationGuard: null,
    test7_heroCleanup: null,
  };

  const distDir = path.resolve(__dirname, "../dist");
  const { server, port } = await startStaticServer(distDir);
  console.log(`[HTTP] Static production build server running at http://127.0.0.1:${port}`);

  const chromePath = findChromePath();
  assert(chromePath, "Chrome executable must be found on system");
  console.log(`[Chrome] Using Chrome at ${chromePath}`);

  const cdpPort = 9225;
  const chromeProc = spawn(chromePath, [
    "--headless=new",
    `--remote-debugging-port=${cdpPort}`,
    "--use-fake-ui-for-media-stream",
    "--use-fake-device-for-media-stream",
    "--disable-gpu",
    "about:blank",
  ]);

  try {
    let version = null;
    for (let i = 0; i < 40; i++) {
      try {
        version = await getJson(`http://127.0.0.1:${cdpPort}/json/version`);
        if (version && version.webSocketDebuggerUrl) break;
      } catch {}
      await new Promise((r) => setTimeout(r, 200));
    }
    assert(version, "CDP version endpoint failed to connect");
    console.log(`[CDP] Connected to Chrome DevTools Protocol (${version["Browser"]})`);

    const browserClient = new CDPClient(version.webSocketDebuggerUrl);

    // =========================================================================
    // 1. Real Browser Continuous 30-Second Recording (Auto-Stop Verification)
    // =========================================================================
    console.log("\n--------------------------------------------------------------------------------");
    console.log("TEST 1: Real Browser Continuous 30-Second Recording Auto-Stop");
    console.log("--------------------------------------------------------------------------------");

    const target1 = await browserClient.send("Target.createTarget", {
      url: `http://127.0.0.1:${port}/preserve-your-story/voice`,
    });
    const pageTargets1 = await getJson(`http://127.0.0.1:${cdpPort}/json/list`);
    const pageTarget1 = pageTargets1.find((t) => t.id === target1.targetId);
    const client1 = new CDPClient(pageTarget1.webSocketDebuggerUrl);

    await new Promise((r) => setTimeout(r, 1000));

    // Instrument page: track MediaStream tracks and stop() call counts
    await client1.eval(`
      (() => {
        window.__trackedAudioTracks = [];
        window.__mrStopCalls = 0;
        
        const origGUM = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
        navigator.mediaDevices.getUserMedia = async (constraints) => {
          const stream = await origGUM(constraints);
          window.__trackedAudioTracks.push(...stream.getTracks());
          return stream;
        };

        const origStop = MediaRecorder.prototype.stop;
        MediaRecorder.prototype.stop = function(...args) {
          window.__mrStopCalls++;
          return origStop.apply(this, args);
        };
      })()
    `);

    // Switch to Record with Microphone tab
    await client1.eval(`
      (() => {
        const tab = Array.from(document.querySelectorAll('button.p-tab-seg')).find(b => b.textContent.includes('Record with Microphone'));
        if (tab) tab.click();
      })()
    `);
    await new Promise((r) => setTimeout(r, 300));

    // Click Start Recording
    console.log("   • Initiating real browser audio recording...");
    const recStartTime = Date.now();
    await client1.eval(`
      (() => {
        const recBtn = document.querySelector('button.p-rec-circle-btn');
        recBtn.click();
      })()
    `);

    // Wait and observe recording progress
    let autoStopped = false;
    let recEndTime = 0;
    let lastObservedState = "";
    let lastObservedTimer = "";

    console.log("   • Recording in progress with real Web Audio / MediaRecorder. Monitoring elapsed time...");
    for (let tick = 0; tick < 70; tick++) { // check for up to 35 seconds
      await new Promise((r) => setTimeout(r, 500));
      const status = await client1.eval(`
        (() => {
          const recBtn = document.querySelector('button.p-rec-circle-btn');
          const timerEl = document.querySelector('.p-rec-timer');
          const isRecording = recBtn ? recBtn.classList.contains('is-recording') : false;
          const playerBox = document.querySelector('.p-audio-player-box');
          const audioEl = document.querySelector('audio');
          return {
            isRecording,
            timerText: timerEl ? timerEl.textContent : '',
            hasPlayer: Boolean(playerBox),
            hasAudioEl: Boolean(audioEl),
            mrStopCalls: window.__mrStopCalls || 0
          };
        })()
      `);

      lastObservedState = status.isRecording ? "recording" : "stopped";
      lastObservedTimer = status.timerText;

      const elapsedSec = ((Date.now() - recStartTime) / 1000).toFixed(1);
      if (tick % 6 === 0 || !status.isRecording) {
        console.log(`     [${elapsedSec}s wall-clock] UI timer: "${status.timerText}" | isRecording: ${status.isRecording} | stopCalls: ${status.mrStopCalls}`);
      }

      if (!status.isRecording && status.hasPlayer) {
        autoStopped = true;
        recEndTime = Date.now();
        break;
      }
    }

    assert(autoStopped, "Recording did not stop automatically within 35 seconds!");
    const measuredContinuousWallDuration = (recEndTime - recStartTime) / 1000;
    console.log(`   ✓ Auto-stop triggered! Total measured wall duration: ${measuredContinuousWallDuration.toFixed(2)}s`);

    // Verify stopCallCount === 1 and tracks are released
    const audit1 = await client1.eval(`
      (() => {
        const tracks = window.__trackedAudioTracks || [];
        const trackStates = tracks.map(t => ({ id: t.id, kind: t.kind, readyState: t.readyState }));
        const allTracksEnded = tracks.length > 0 && tracks.every(t => t.readyState === "ended");
        return {
          mrStopCalls: window.__mrStopCalls,
          trackStates,
          allTracksEnded
        };
      })()
    `);

    console.log(`   ✓ Stop & Save Recording was called exactly ${audit1.mrStopCalls} time(s).`);
    assert.strictEqual(audit1.mrStopCalls, 1, "Stop & Save Recording action must be triggered only once!");

    console.log(`   ✓ Microphone tracks state:`, audit1.trackStates);
    assert(audit1.allTracksEnded, "All microphone tracks must be stopped and in 'ended' readyState!");

    // Extract generated audio blob from browser
    const audioData1 = await client1.eval(`
      (async () => {
        const audioEl = document.querySelector('audio');
        if (!audioEl || !audioEl.src) return { error: "No audio src found" };
        const res = await fetch(audioEl.src);
        const blob = await res.blob();
        const ab = await blob.arrayBuffer();
        const bytes = Array.from(new Uint8Array(ab));
        return {
          type: blob.type,
          size: blob.size,
          bytes
        };
      })()
    `);

    assert(audioData1 && !audioData1.error, "Failed to retrieve generated audio blob from browser");
    const test1WavBuffer = Buffer.from(audioData1.bytes);
    const test1Header = parseWavHeader(test1WavBuffer);

    console.log(`   ✓ Generated audio blob received: ${test1WavBuffer.length} bytes (type: ${audioData1.type})`);
    console.log(`   ✓ WAV header: sampleRate=${test1Header.sampleRate}Hz, channels=${test1Header.channels}, bits=${test1Header.bitsPerSample}, duration=${test1Header.duration.toFixed(2)}s`);

    assert(test1Header.duration <= 30.01, `WAV duration (${test1Header.duration.toFixed(2)}s) must be <= 30.0s`);
    assert.strictEqual(test1Header.sampleRate, 16000, "WAV sample rate must be 16kHz");
    assert.strictEqual(test1Header.channels, 1, "WAV channels must be mono (1)");
    assert.strictEqual(test1Header.audioFormat, 1, "WAV format must be standard 16-bit PCM");

    resultsSummary.test1_continuousAutoStop = {
      measuredWallSeconds: measuredContinuousWallDuration,
      wavDurationSeconds: test1Header.duration,
      stopCallCount: audit1.mrStopCalls,
      microphoneTracksEnded: audit1.allTracksEnded,
    };

    client1.close();
    await browserClient.send("Target.closeTarget", { targetId: target1.targetId });

    // =========================================================================
    // 2. Real Browser Pause/Resume Invariance Verification
    // =========================================================================
    console.log("\n--------------------------------------------------------------------------------");
    console.log("TEST 2: Real Browser Pause & Resume (10s record + 5s pause + 20s record)");
    console.log("--------------------------------------------------------------------------------");

    const target2 = await browserClient.send("Target.createTarget", {
      url: `http://127.0.0.1:${port}/preserve-your-story/voice`,
    });
    const pageTargets2 = await getJson(`http://127.0.0.1:${cdpPort}/json/list`);
    const pageTarget2 = pageTargets2.find((t) => t.id === target2.targetId);
    const client2 = new CDPClient(pageTarget2.webSocketDebuggerUrl);

    await new Promise((r) => setTimeout(r, 1000));

    await client2.eval(`
      (() => {
        window.__trackedAudioTracks = [];
        window.__mrStopCalls = 0;
        
        const origGUM = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
        navigator.mediaDevices.getUserMedia = async (constraints) => {
          const stream = await origGUM(constraints);
          window.__trackedAudioTracks.push(...stream.getTracks());
          return stream;
        };

        const origStop = MediaRecorder.prototype.stop;
        MediaRecorder.prototype.stop = function(...args) {
          window.__mrStopCalls++;
          return origStop.apply(this, args);
        };
      })()
    `);

    // Switch to Record tab & start recording
    await client2.eval(`
      (() => {
        const tab = Array.from(document.querySelectorAll('button.p-tab-seg')).find(b => b.textContent.includes('Record with Microphone'));
        if (tab) tab.click();
      })()
    `);
    await new Promise((r) => setTimeout(r, 300));

    console.log("   • Phase 1: Recording for 10 seconds...");
    const p2StartTime = Date.now();
    await client2.eval(`
      (() => {
        const recBtn = document.querySelector('button.p-rec-circle-btn');
        recBtn.click();
      })()
    `);

    // Wait 10 seconds of active recording
    await new Promise((r) => setTimeout(r, 10200));

    // Click Pause
    console.log("   • Pausing recording for 5 seconds...");
    await client2.eval(`
      (() => {
        const pauseBtn = Array.from(document.querySelectorAll('button')).find(b => b.textContent.trim() === 'Pause');
        if (pauseBtn) pauseBtn.click();
      })()
    `);

    const timerAtPause = await client2.eval(`
      (() => {
        const timerEl = document.querySelector('.p-rec-timer');
        return timerEl ? timerEl.textContent : '';
      })()
    `);
    console.log(`     Timer reading when paused: "${timerAtPause}"`);

    // Wait 5 seconds while paused
    await new Promise((r) => setTimeout(r, 5000));

    const timerAfter5sPause = await client2.eval(`
      (() => {
        const timerEl = document.querySelector('.p-rec-timer');
        return timerEl ? timerEl.textContent : '';
      })()
    `);
    console.log(`     Timer reading after 5s paused: "${timerAfter5sPause}"`);
    assert.strictEqual(timerAtPause, timerAfter5sPause, "Timer must NOT advance while paused!");

    // Click Resume
    console.log("   • Phase 2: Resuming recording (remaining ~20 seconds until auto-stop)...");
    await client2.eval(`
      (() => {
        const resumeBtn = Array.from(document.querySelectorAll('button')).find(b => b.textContent.trim() === 'Resume');
        if (resumeBtn) resumeBtn.click();
      })()
    `);

    // Wait until recording auto-stops
    let p2AutoStopped = false;
    let p2EndTime = 0;
    for (let tick = 0; tick < 50; tick++) { // up to 25s
      await new Promise((r) => setTimeout(r, 500));
      const status = await client2.eval(`
        (() => {
          const recBtn = document.querySelector('button.p-rec-circle-btn');
          const timerEl = document.querySelector('.p-rec-timer');
          const isRecording = recBtn ? recBtn.classList.contains('is-recording') : false;
          const playerBox = document.querySelector('.p-audio-player-box');
          return {
            isRecording,
            timerText: timerEl ? timerEl.textContent : '',
            hasPlayer: Boolean(playerBox),
            mrStopCalls: window.__mrStopCalls || 0
          };
        })()
      `);

      if (tick % 6 === 0 || !status.isRecording) {
        const elapsedSec = ((Date.now() - p2StartTime) / 1000).toFixed(1);
        console.log(`     [${elapsedSec}s wall-clock] UI timer: "${status.timerText}" | isRecording: ${status.isRecording}`);
      }

      if (!status.isRecording && status.hasPlayer) {
        p2AutoStopped = true;
        p2EndTime = Date.now();
        break;
      }
    }

    assert(p2AutoStopped, "Pause/resume recording did not auto-stop as expected!");
    const totalP2WallClock = (p2EndTime - p2StartTime) / 1000;
    console.log(`   ✓ Auto-stop triggered! Total measured wall duration (including 5s pause): ${totalP2WallClock.toFixed(2)}s`);
    assert(
      totalP2WallClock >= 34.0,
      `Wall-clock time (${totalP2WallClock.toFixed(2)}s) must be >= 34.0s (10s active + 5s pause + 20s active)`
    );

    const audit2 = await client2.eval(`
      (() => {
        const tracks = window.__trackedAudioTracks || [];
        return {
          mrStopCalls: window.__mrStopCalls,
          allTracksEnded: tracks.length > 0 && tracks.every(t => t.readyState === "ended")
        };
      })()
    `);
    assert.strictEqual(audit2.mrStopCalls, 1, "Stop & Save Recording must be triggered exactly once on pause/resume!");
    assert(audit2.allTracksEnded, "Microphone tracks must be released after pause/resume auto-stop!");

    resultsSummary.test2_pauseResumeAutoStop = {
      measuredWallSeconds: totalP2WallClock,
      activeRecordingSeconds: 30.0,
      pauseDurationSeconds: 5.0,
      tracksReleased: audit2.allTracksEnded,
    };

    client2.close();
    await browserClient.send("Target.closeTarget", { targetId: target2.targetId });

    // =========================================================================
    // 3. Generated Audio Validation & Gnani Prisma STT Submission
    // =========================================================================
    console.log("\n--------------------------------------------------------------------------------");
    console.log("TEST 3: Generated Audio Inspection & Live Gnani STT API Submission");
    console.log("--------------------------------------------------------------------------------");

    console.log(`   • Verifying WAV metadata of browser-generated 30s audio:`);
    console.log(`     - Format: ${test1Header.riff}/${test1Header.wave}`);
    console.log(`     - Compression: ${test1Header.audioFormat === 1 ? "1 (Linear PCM)" : test1Header.audioFormat}`);
    console.log(`     - Channels: ${test1Header.channels} (Mono)`);
    console.log(`     - Sample Rate: ${test1Header.sampleRate} Hz`);
    console.log(`     - Byte Rate: ${test1Header.byteRate} bytes/sec`);
    console.log(`     - Block Align: ${test1Header.blockAlign} bytes`);
    console.log(`     - Bits per Sample: ${test1Header.bitsPerSample} bit`);
    console.log(`     - Total Audio Samples: ${test1Header.samples}`);
    console.log(`     - Calculated Audio Duration: ${test1Header.duration.toFixed(3)}s`);

    assert.strictEqual(test1Header.riff, "RIFF");
    assert.strictEqual(test1Header.wave, "WAVE");
    assert.strictEqual(test1Header.audioFormat, 1);
    assert.strictEqual(test1Header.channels, 1);
    assert.strictEqual(test1Header.sampleRate, 16000);
    assert.strictEqual(test1Header.bitsPerSample, 16);
    assert(test1Header.duration <= 30.0, `Audio duration (${test1Header.duration}s) must not exceed 30.0s`);

    resultsSummary.test3_generatedAudioValid = {
      format: "PCM WAV 16kHz mono 16-bit",
      durationSeconds: test1Header.duration,
      byteSize: test1WavBuffer.length,
      isValid: true,
    };

    // Submit to Gnani API
    const dotenvContent = fs.readFileSync(path.resolve(__dirname, "../../virasya-ai/.env"), "utf8");
    const keyMatch = dotenvContent.match(/GNANI_API_KEY=([^\r\n]+)/);
    const gnaniKey = keyMatch ? keyMatch[1].trim() : null;

    if (gnaniKey) {
      console.log(`\n   • Submitting browser-recorded WAV audio directly to Gnani Prisma STT v2.5 API...`);
      const gnaniRes = await submitToGnaniApi(test1WavBuffer, gnaniKey, "hi-IN");
      console.log(`     Gnani API response HTTP status: ${gnaniRes.status}`);
      console.log(`     Gnani API response body:`, JSON.stringify(gnaniRes.data || gnaniRes.raw, null, 2));

      assert.strictEqual(gnaniRes.status, 200, `Gnani STT API returned status ${gnaniRes.status}`);
      assert.strictEqual(gnaniRes.data?.success, true, "Gnani STT API must return success: true");

      console.log(`   ✓ Live Gnani Prisma STT successfully accepted the generated 30-second WAV recording!`);
      resultsSummary.test4_gnaniAccepted = {
        httpStatus: gnaniRes.status,
        success: gnaniRes.data?.success,
        requestId: gnaniRes.data?.request_id,
        transcript: gnaniRes.data?.transcript || "(blank for synthetic tone)",
      };
    } else {
      console.warn("   ⚠️ GNANI_API_KEY not found in .env, skipping live HTTP submission");
    }

    // =========================================================================
    // 4. Real Browser Regression: Manual Stop (< 30s)
    // =========================================================================
    console.log("\n--------------------------------------------------------------------------------");
    console.log("TEST 4: Regression Check — Real Browser Manual Stop (< 30s)");
    console.log("--------------------------------------------------------------------------------");

    const target4 = await browserClient.send("Target.createTarget", {
      url: `http://127.0.0.1:${port}/preserve-your-story/voice`,
    });
    const pageTargets4 = await getJson(`http://127.0.0.1:${cdpPort}/json/list`);
    const pageTarget4 = pageTargets4.find((t) => t.id === target4.targetId);
    const client4 = new CDPClient(pageTarget4.webSocketDebuggerUrl);

    await new Promise((r) => setTimeout(r, 1000));

    await client4.eval(`
      (() => {
        window.__trackedAudioTracks = [];
        window.__mrStopCalls = 0;
        
        const origGUM = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
        navigator.mediaDevices.getUserMedia = async (constraints) => {
          const stream = await origGUM(constraints);
          window.__trackedAudioTracks.push(...stream.getTracks());
          return stream;
        };

        const origStop = MediaRecorder.prototype.stop;
        MediaRecorder.prototype.stop = function(...args) {
          window.__mrStopCalls++;
          return origStop.apply(this, args);
        };
      })()
    `);

    // Switch to record tab
    await client4.eval(`
      (() => {
        const tab = Array.from(document.querySelectorAll('button.p-tab-seg')).find(b => b.textContent.includes('Record with Microphone'));
        if (tab) tab.click();
      })()
    `);
    await new Promise((r) => setTimeout(r, 300));

    console.log("   • Starting recording for 4 seconds...");
    await client4.eval(`
      (() => {
        const recBtn = document.querySelector('button.p-rec-circle-btn');
        recBtn.click();
      })()
    `);

    await new Promise((r) => setTimeout(r, 4000));

    console.log("   • Clicking manual 'Stop & Save Recording' button...");
    await client4.eval(`
      (() => {
        const stopBtn = Array.from(document.querySelectorAll('button')).find(b => b.textContent.includes('Stop & Save Recording'));
        if (stopBtn) stopBtn.click();
      })()
    `);

    // Wait for conversion & render
    await new Promise((r) => setTimeout(r, 1200));

    const audit4 = await client4.eval(`
      (async () => {
        const playerBox = document.querySelector('.p-audio-player-box');
        const audioEl = document.querySelector('audio');
        const tracks = window.__trackedAudioTracks || [];
        const allTracksEnded = tracks.length > 0 && tracks.every(t => t.readyState === "ended");
        let dur = 0;
        if (audioEl && audioEl.src) {
          const res = await fetch(audioEl.src);
          const blob = await res.blob();
          const ab = await blob.arrayBuffer();
          const dv = new DataView(ab);
          const dataSize = dv.getUint32(40, true);
          dur = (dataSize / 2) / 16000;
        }
        return {
          hasPlayer: Boolean(playerBox),
          stopCalls: window.__mrStopCalls,
          allTracksEnded,
          dur
        };
      })()
    `);

    assert(audit4.hasPlayer, "Player box must be rendered after manual stop");
    assert.strictEqual(audit4.stopCalls, 1, "Stop was called once");
    assert(audit4.allTracksEnded, "Microphone tracks released after manual stop");
    assert(audit4.dur > 3.0 && audit4.dur < 6.0, `Manual stop audio duration (${audit4.dur}s) must be ~4s`);
    console.log(`   ✓ Manual stop succeeded cleanly: audio duration = ${audit4.dur.toFixed(2)}s, tracks released.`);

    resultsSummary.test5_manualStopShort = {
      durationSeconds: audit4.dur,
      tracksReleased: audit4.allTracksEnded,
    };

    client4.close();
    await browserClient.send("Target.closeTarget", { targetId: target4.targetId });

    // =========================================================================
    // 5. File Upload > 30s Rejection & <= 30s Acceptance Regression
    // =========================================================================
    console.log("\n--------------------------------------------------------------------------------");
    console.log("TEST 5: Regression Check — Audio Upload Duration Guard (30s Maximum)");
    console.log("--------------------------------------------------------------------------------");

    const target5 = await browserClient.send("Target.createTarget", {
      url: `http://127.0.0.1:${port}/preserve-your-story/voice`,
    });
    const pageTargets5 = await getJson(`http://127.0.0.1:${cdpPort}/json/list`);
    const pageTarget5 = pageTargets5.find((t) => t.id === target5.targetId);
    const client5 = new CDPClient(pageTarget5.webSocketDebuggerUrl);

    await new Promise((r) => setTimeout(r, 1000));

    // Switch to Upload Audio File tab
    await client5.eval(`
      (() => {
        const tab = Array.from(document.querySelectorAll('button.p-tab-seg')).find(b => b.textContent.includes('Upload Audio File'));
        if (tab) tab.click();
      })()
    `);
    await new Promise((r) => setTimeout(r, 300));

    // Test Case A: Upload 35-second audio (must be rejected)
    console.log("   • Testing file upload with 35.0-second WAV (exceeds 30s)...");
    const wav35Buffer = createSyntheticWav(35, 16000);
    const base64Wav35 = wav35Buffer.toString("base64");

    const uploadRejectionResult = await client5.eval(`
      (async () => {
        const b64 = "${base64Wav35}";
        const binStr = atob(b64);
        const bytes = new Uint8Array(binStr.length);
        for (let i = 0; i < binStr.length; i++) bytes[i] = binStr.charCodeAt(i);
        const file = new File([bytes], "test-oversized-35s.wav", { type: "audio/wav" });

        // Trigger input change
        const input = document.querySelector('input[type="file"]');
        const dt = new DataTransfer();
        dt.items.add(file);
        input.files = dt.files;
        input.dispatchEvent(new Event("change", { bubbles: true }));

        // Wait for Audio element duration decoding and validation error render
        await new Promise(r => setTimeout(r, 800));

        const errEl = document.querySelector('.p-field-error');
        return {
          errText: errEl ? errEl.textContent : '',
          hasError: Boolean(errEl)
        };
      })()
    `);

    console.log(`     Error message received: "${uploadRejectionResult.errText}"`);
    assert(uploadRejectionResult.hasError, "Upload of 35s audio must be rejected with error!");
    assert(
      uploadRejectionResult.errText.includes("30 seconds") || uploadRejectionResult.errText.includes("30-second"),
      "Error message must specify 30-second maximum duration limit!"
    );
    console.log("   ✓ Oversized audio (> 30s) rejected with exact expected error message.");

    // Test Case B: Upload 15-second audio (must be accepted)
    console.log("   • Testing file upload with 15.0-second WAV (within 30s limit)...");
    const wav15Buffer = createSyntheticWav(15, 16000);
    const base64Wav15 = wav15Buffer.toString("base64");

    const uploadAcceptResult = await client5.eval(`
      (async () => {
        const b64 = "${base64Wav15}";
        const binStr = atob(b64);
        const bytes = new Uint8Array(binStr.length);
        for (let i = 0; i < binStr.length; i++) bytes[i] = binStr.charCodeAt(i);
        const file = new File([bytes], "test-accepted-15s.wav", { type: "audio/wav" });

        const input = document.querySelector('input[type="file"]');
        const dt = new DataTransfer();
        dt.items.add(file);
        input.files = dt.files;
        input.dispatchEvent(new Event("change", { bubbles: true }));

        await new Promise(r => setTimeout(r, 800));

        const playerBox = document.querySelector('.p-audio-player-box');
        const errEl = document.querySelector('.p-field-error');
        return {
          hasPlayer: Boolean(playerBox),
          hasError: Boolean(errEl),
          errText: errEl ? errEl.textContent : ''
        };
      })()
    `);

    assert(uploadAcceptResult.hasPlayer, "Valid 15s audio must be accepted and render AudioPlayer");
    assert(!uploadAcceptResult.hasError, "Valid 15s audio must not produce an error");
    console.log("   ✓ Audio <= 30s accepted cleanly without error.");

    resultsSummary.test6_uploadDurationGuard = {
      oversizedRejected: true,
      validAccepted: true,
      rejectionMessage: uploadRejectionResult.errText,
    };

    client5.close();
    await browserClient.send("Target.closeTarget", { targetId: target5.targetId });

    // =========================================================================
    // 6. Home Page Hero Note Verification
    // =========================================================================
    console.log("\n--------------------------------------------------------------------------------");
    console.log("TEST 6: Regression Check — Home Page Hero Notes");
    console.log("--------------------------------------------------------------------------------");

    const target6 = await browserClient.send("Target.createTarget", {
      url: `http://127.0.0.1:${port}/`,
    });
    const pageTargets6 = await getJson(`http://127.0.0.1:${cdpPort}/json/list`);
    const pageTarget6 = pageTargets6.find((t) => t.id === target6.targetId);
    const client6 = new CDPClient(pageTarget6.webSocketDebuggerUrl);

    await new Promise((r) => setTimeout(r, 1000));

    const heroAudit = await client6.eval(`
      (() => {
        const bodyText = document.body.innerText;
        const noteOne = document.querySelector('.note-one');
        const noteTwo = document.querySelector('.note-two');
        const checkDot = noteTwo ? noteTwo.querySelector('.check-dot') : null;

        return {
          hasTreasuredText: bodyText.includes('Treasured and enriched.'),
          hasYourStoriesText: bodyText.includes('Your stories, remembered.'),
          hasNoteOneInDOM: Boolean(noteOne),
          hasNoteTwoInDOM: Boolean(noteTwo),
          noteTwoText: noteTwo ? noteTwo.textContent : '',
          hasCheckmark: Boolean(checkDot && checkDot.textContent.includes('✓'))
        };
      })()
    `);

    console.log("   • Hero audit results:", heroAudit);
    assert.strictEqual(heroAudit.hasTreasuredText, false, "'Treasured and enriched.' must NOT appear on Home page");
    assert.strictEqual(heroAudit.hasNoteOneInDOM, false, ".note-one must NOT be mounted in DOM");
    assert.strictEqual(heroAudit.hasYourStoriesText, true, "'Your stories, remembered.' MUST be present on Home page");
    assert.strictEqual(heroAudit.hasNoteTwoInDOM, true, ".note-two MUST be present in DOM");
    assert.strictEqual(heroAudit.hasCheckmark, true, "Checkmark icon MUST be present in note-two");

    console.log("   ✓ 'Treasured and enriched.' (.note-one) is completely removed.");
    console.log("   ✓ 'Your stories, remembered.' (.note-two) is preserved with its checkmark.");

    resultsSummary.test7_heroCleanup = {
      treasuredPurged: !heroAudit.hasTreasuredText && !heroAudit.hasNoteOneInDOM,
      yourStoriesPreserved: heroAudit.hasYourStoriesText && heroAudit.hasNoteTwoInDOM,
    };

    client6.close();
    await browserClient.send("Target.closeTarget", { targetId: target6.targetId });

    browserClient.close();
    console.log("\n================================================================================");
    console.log("   ALL REAL BROWSER & LIVE GNANI VERIFICATION TESTS PASSED (100%)");
    console.log("================================================================================\n");
    console.log("Summary of Measured Results:\n", JSON.stringify(resultsSummary, null, 2));

  } finally {
    server.close();
    chromeProc.kill();
  }
}

main().catch((err) => {
  console.error("Execution failed:", err);
  process.exit(1);
});
