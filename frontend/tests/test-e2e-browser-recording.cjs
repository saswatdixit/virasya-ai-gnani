const { spawn } = require("child_process");
const http = require("http");
const fs = require("fs");
const path = require("path");

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

async function run() {
  const distDir = path.resolve(__dirname, "../dist");
  const { server, port } = await startStaticServer(distDir);
  console.log(`Static server running on http://127.0.0.1:${port}`);

  const chromePath = findChromePath();
  const chromeProc = spawn(chromePath, [
    "--headless=new",
    "--remote-debugging-port=9224",
    "--use-fake-ui-for-media-stream",
    "--use-fake-device-for-media-stream",
    "--disable-gpu",
    "about:blank",
  ]);

  try {
    let version = null;
    for (let i = 0; i < 30; i++) {
      try {
        version = await getJson("http://127.0.0.1:9224/json/version");
        if (version && version.webSocketDebuggerUrl) break;
      } catch {}
      await new Promise((r) => setTimeout(r, 200));
    }

    const browserClient = new CDPClient(version.webSocketDebuggerUrl);

    // Test across viewports (320px, 375px)
    for (const width of [320, 375]) {
      console.log(`\n--- Testing E2E Browser Recording at ${width}px viewport ---`);

      const target = await browserClient.send("Target.createTarget", {
        url: `http://127.0.0.1:${port}/preserve-your-story/voice`,
      });
      const pageTargets = await getJson("http://127.0.0.1:9224/json/list");
      const pageTarget = pageTargets.find((t) => t.id === target.targetId);
      const pageClient = new CDPClient(pageTarget.webSocketDebuggerUrl);

      await pageClient.send("Emulation.setDeviceMetricsOverride", {
        width,
        height: 800,
        deviceScaleFactor: 2,
        mobile: true,
      });

      // Wait for page load
      await new Promise((r) => setTimeout(r, 800));

      // 1. Switch to 'Record with Microphone' tab
      const tabResult = await pageClient.eval(`
        (() => {
          const tab = Array.from(document.querySelectorAll('button.p-tab-seg')).find(b => b.textContent.includes('Record with Microphone'));
          if (!tab) return { error: "Record tab not found" };
          tab.click();
          return { clickedTab: true };
        })()
      `);
      console.log(`   [Tab Switch]`, tabResult);

      // Wait a moment for UI to switch tab
      await new Promise((r) => setTimeout(r, 200));

      // Check layout bounds
      const initialLayout = await pageClient.eval(`
        (() => {
          const sw = document.documentElement.scrollWidth;
          const cw = document.documentElement.clientWidth;
          const recBtn = document.querySelector('button.p-rec-circle-btn');
          const hasOverflow = sw > cw;
          return {
            sw,
            cw,
            hasOverflow,
            hasRecBtn: Boolean(recBtn),
            recBtnVisible: recBtn ? recBtn.getBoundingClientRect().width > 0 : false
          };
        })()
      `);
      console.log(`   [Initial Layout @ ${width}px] scrollWidth=${initialLayout.sw}, clientWidth=${initialLayout.cw}, hasRecBtn=${initialLayout.hasRecBtn}`);
      if (initialLayout.hasOverflow) {
        throw new Error(`Horizontal overflow on voice page before recording at ${width}px!`);
      }

      // 2. Click the Circle Record button to start recording
      const startResult = await pageClient.eval(`
        (async () => {
          const recBtn = document.querySelector('button.p-rec-circle-btn');
          if (!recBtn) return { error: "Record circle button not found" };
          recBtn.click();
          return { started: true };
        })()
      `);
      console.log(`   [Record Start]`, startResult);

      // Let it record for 1.2 seconds
      await new Promise((r) => setTimeout(r, 1200));

      // 3. Verify recording active state & mobile bounds during recording
      const recordingLayout = await pageClient.eval(`
        (() => {
          const sw = document.documentElement.scrollWidth;
          const cw = document.documentElement.clientWidth;
          const stopBtn = document.querySelector('button.p-rec-action-btn.stop') || document.querySelector('button.p-rec-circle-btn.is-recording');
          const waveCanvas = document.querySelector('canvas.p-wave-canvas');
          return {
            sw,
            cw,
            hasOverflow: sw > cw,
            hasStopBtn: Boolean(stopBtn),
            hasWaveCanvas: Boolean(waveCanvas)
          };
        })()
      `);
      console.log(`   [Active Recording @ ${width}px] scrollWidth=${recordingLayout.sw}, clientWidth=${recordingLayout.cw}, hasStopBtn=${recordingLayout.hasStopBtn}`);
      if (recordingLayout.hasOverflow) {
        throw new Error(`Horizontal overflow on voice page DURING recording at ${width}px!`);
      }

      // 4. Click the Stop button to finish recording and trigger conversion
      const stopResult = await pageClient.eval(`
        (async () => {
          const stopBtn = document.querySelector('button.p-rec-action-btn.stop') || document.querySelector('button.p-rec-circle-btn.is-recording');
          if (!stopBtn) return { error: "Stop button not found" };
          stopBtn.click();
          return { stopped: true };
        })()
      `);
      console.log(`   [Record Stop]`, stopResult);

      // Wait 1 second for decodeAudioData + WAV conversion + AudioPlayer render
      await new Promise((r) => setTimeout(r, 1200));

      // 5. Inspect the recorded audio result in frontend state
      const audioResult = await pageClient.eval(`
        (async () => {
          const sw = document.documentElement.scrollWidth;
          const cw = document.documentElement.clientWidth;
          const player = document.querySelector('.p-audio-player');
          const audioEl = document.querySelector('audio');
          const src = audioEl ? audioEl.src : null;
          
          let blobInfo = null;
          if (src && src.startsWith('blob:')) {
            const resp = await fetch(src);
            const blob = await resp.blob();
            const ab = await blob.arrayBuffer();
            const header = new Uint8Array(ab.slice(0, 12));
            const riff = String.fromCharCode(...header.slice(0, 4));
            const wave = String.fromCharCode(...header.slice(8, 12));
            blobInfo = {
              type: blob.type,
              size: blob.size,
              riff,
              wave
            };
          }
          
          return {
            sw,
            cw,
            hasOverflow: sw > cw,
            hasPlayer: Boolean(player),
            hasAudioEl: Boolean(audioEl),
            blobInfo
          };
        })()
      `);

      console.log(`   [Post-Recording Layout @ ${width}px] scrollWidth=${audioResult.sw}, clientWidth=${audioResult.cw}`);
      console.log(`   [Audio Artifact]`, JSON.stringify(audioResult.blobInfo, null, 2));

      if (audioResult.hasOverflow) {
        throw new Error(`Horizontal overflow on voice page AFTER recording at ${width}px!`);
      }
      if (!audioResult.blobInfo) {
        throw new Error(`No audio blob generated after recording!`);
      }
      if (audioResult.blobInfo.riff !== "RIFF" || audioResult.blobInfo.wave !== "WAVE") {
        throw new Error(`Recorded audio is NOT a valid RIFF/WAVE file! Header was: ${audioResult.blobInfo.riff}/${audioResult.blobInfo.wave}`);
      }
      if (audioResult.blobInfo.type !== "audio/wav") {
        throw new Error(`Recorded audio blob type is not audio/wav! Was: ${audioResult.blobInfo.type}`);
      }

      console.log(`   ✓ Browser recording at ${width}px successfully produced valid RIFF/WAVE PCM audio/wav blob!`);

      pageClient.close();
      await browserClient.send("Target.closeTarget", { targetId: target.targetId });
    }

    browserClient.close();
    console.log("\n=== ALL E2E BROWSER RECORDING & MOBILE VIEWPORT TESTS PASSED ===");
  } finally {
    server.close();
    chromeProc.kill();
  }
}

run().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
