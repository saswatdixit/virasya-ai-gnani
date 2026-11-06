/**
 * Real Browser CDP Verification for:
 * 1. Dual Independent Narrative Text Boxes (Written Context vs Audio Transcription)
 * 2. Complete Removal of Uploaded Audio Filename from Player UI
 * 3. Responsive Layout (Desktop 2-column grid vs Mobile 1-column stack)
 */

const { spawn } = require("child_process");
const http = require("http");
const assert = require("assert");
const fs = require("fs");
const path = require("path");

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
      if (msg.method === "Runtime.consoleAPICalled") {
        console.log("   [Browser Console]", msg.params.type, msg.params.args.map(a => a.value || a.description).join(" "));
      }
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

  async eval(expr) {
    const res = await this.send("Runtime.evaluate", {
      expression: expr,
      returnByValue: true,
      awaitPromise: true,
    });
    if (res.exceptionDetails) {
      throw new Error("Evaluation error: " + JSON.stringify(res.exceptionDetails));
    }
    return res.result?.value;
  }

  close() {
    if (this.ws) this.ws.close();
  }
}

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function createStaticSpaServer(distDir) {
  return http.createServer((req, res) => {
    const parsedUrl = new URL(req.url, "http://localhost");
    let pathname = parsedUrl.pathname;
    let filePath = path.join(distDir, pathname);

    if (pathname.startsWith("/maps/")) {
      const publicMapPath = path.resolve(__dirname, "../public", pathname.slice(1));
      if (fs.existsSync(publicMapPath)) {
        res.writeHead(200, { "Content-Type": "application/json" });
        fs.createReadStream(publicMapPath).pipe(res);
        return;
      }
    }

    if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
      const ext = path.extname(filePath);
      const mimeTypes = {
        ".html": "text/html",
        ".js": "application/javascript",
        ".css": "text/css",
        ".json": "application/json",
        ".svg": "image/svg+xml",
        ".wav": "audio/wav",
        ".ogg": "audio/ogg",
      };
      res.writeHead(200, { "Content-Type": mimeTypes[ext] || "application/octet-stream" });
      fs.createReadStream(filePath).pipe(res);
    } else {
      res.writeHead(200, { "Content-Type": "text/html" });
      fs.createReadStream(path.join(distDir, "index.html")).pipe(res);
    }
  });
}

(async () => {
  console.log("=== Real Browser CDP Verification: Dual Text Boxes & Hidden Audio Filename ===\n");

  const distDir = path.resolve(__dirname, "../dist");
  if (!fs.existsSync(distDir) || !fs.existsSync(path.join(distDir, "index.html"))) {
    console.error("FAIL: dist/ directory not found. Please run npm run build first.");
    process.exit(1);
  }

  const appServer = createStaticSpaServer(distDir);
  await new Promise((resolve) => appServer.listen(0, "127.0.0.1", resolve));
  const appPort = appServer.address().port;
  const appUrl = `http://127.0.0.1:${appPort}/explore`;
  console.log(`• Spawned static SPA server on ${appUrl}`);

  const chromePath = findChromePath();
  if (!chromePath) {
    console.warn("Chrome executable not found. Skipping live CDP test.");
    appServer.close();
    process.exit(0);
  }

  const debugPort = 9224;
  const tempProfile = path.join(process.env.TEMP || "C:\\Temp", `chrome_dual_box_verify_${Date.now()}`);

  const chromeProc = spawn(chromePath, [
    `--remote-debugging-port=${debugPort}`,
    "--headless=new",
    "--disable-gpu",
    "--no-first-run",
    "--no-default-browser-check",
    `--user-data-dir=${tempProfile}`,
    appUrl,
  ], { stdio: "ignore" });

  let client = null;
  try {
    let connected = false;
    let target = null;
    for (let i = 0; i < 20; i++) {
      try {
        const list = await getJson(`http://127.0.0.1:${debugPort}/json/list`);
        target = list.find((t) => t.type === "page" && t.url.includes(String(appPort)));
        if (target) {
          connected = true;
          break;
        }
      } catch {
        await sleep(500);
      }
    }

    if (!connected || !target) {
      throw new Error(`Failed to connect to Headless Chrome CDP target for port ${appPort}.`);
    }

    client = new CDPClient(target.webSocketDebuggerUrl);
    await client.ready;
    await client.send("Page.enable");
    await client.send("Runtime.enable");

    console.log("1. Connected to Chrome CDP target:", target.url);

    // Dismiss Auth modal if present
    for (let i = 0; i < 20; i++) {
      const dismissed = await client.eval(`
        (() => {
          const guestBtn = Array.from(document.querySelectorAll('button')).find(b => b.textContent.includes('Continue as Guest') || b.textContent === '×');
          if (guestBtn) { guestBtn.click(); return true; }
          return false;
        })()
      `);
      if (dismissed) break;
      await sleep(250);
    }

    // Wait for initial feed loading to complete
    for (let i = 0; i < 30; i++) {
      const isLoaded = await client.eval(`!document.querySelector('.p-spinner')`);
      if (isLoaded) break;
      await sleep(500);
    }

    // Click "Explore Preview Stories (Demo Mode) →"
    for (let i = 0; i < 20; i++) {
      const clicked = await client.eval(`
        (() => {
          const previewBtn = Array.from(document.querySelectorAll('button')).find(b => b.textContent.includes('Explore Preview Stories'));
          if (previewBtn) { previewBtn.click(); return true; }
          const hasCards = document.querySelectorAll('.exp-card').length > 0;
          return hasCards;
        })()
      `);
      if (clicked) break;
      await sleep(500);
    }
    await sleep(1000);

    // Open detail for the first story (Grandmother's Khechedi)
    console.log("2. Opening story detail drawer for Grandmother's Khechedi...");
    for (let i = 0; i < 20; i++) {
      const openRes = await client.eval(`
        (() => {
          const readBtns = Array.from(document.querySelectorAll('button')).filter(b => b.textContent.includes('Read & Listen'));
          if (readBtns.length > 0) {
            readBtns[0].click();
            return { clicked: true, count: readBtns.length };
          }
          return { clicked: false, count: 0 };
        })()
      `);
      if (openRes.clicked) break;
      await sleep(500);
    }
    // Wait for drawer content to finish loading
    let modalCheck = null;
    for (let i = 0; i < 30; i++) {
      modalCheck = await client.eval(`
        (() => {
          const drawer = document.querySelector('.exp-drawer');
          const title = document.querySelector('.exp-drawer-title');
          const spinner = drawer?.querySelector('.p-spinner');
          return {
            hasDrawer: Boolean(drawer),
            isLoading: Boolean(spinner),
            title: title ? title.textContent.trim() : null,
            drawerHtml: drawer ? drawer.innerHTML.slice(0, 400) : null
          };
        })()
      `);
      if (modalCheck && modalCheck.hasDrawer && !modalCheck.isLoading && modalCheck.title) break;
      await sleep(500);
    }
    console.log(`   ✓ Drawer opened: "${modalCheck?.title}"`);
    if (!modalCheck?.title) {
      console.log("DEBUG modalCheck:", JSON.stringify(modalCheck));
    }
    assert(modalCheck && modalCheck.hasDrawer, "Detail drawer did not open");
    assert(modalCheck.title, "Drawer title must be loaded");

    // 3. Audio Player Verification: Audio filename must NOT be present
    console.log("\n3. Verifying Audio Player UI & complete absence of audio filename...");
    const audioCheck = await client.eval(`
      (() => {
        const audioEl = document.querySelector('.exp-native-audio');
        const filenameEl = document.querySelector('.exp-audio-filename');
        const badgeEl = document.querySelector('.exp-audio-badge');
        const metaBox = document.querySelector('.exp-audio-meta');

        return {
          hasAudioElement: Boolean(audioEl),
          audioHasControls: audioEl ? audioEl.hasAttribute('controls') : false,
          hasFilenameElement: Boolean(filenameEl),
          filenameInDom: document.body.innerText.includes('Gujarati 5.ogg'),
          badgeText: badgeEl ? badgeEl.textContent.trim() : null,
          metaText: metaBox ? metaBox.innerText.trim() : null,
        };
      })()
    `);

    assert(audioCheck.hasAudioElement, "Audio element must exist");
    assert(audioCheck.audioHasControls, "Audio element must have playback controls");
    assert.strictEqual(audioCheck.hasFilenameElement, false, "DOM must NOT contain .exp-audio-filename");
    assert.strictEqual(audioCheck.filenameInDom, false, "Filename 'Gujarati 5.ogg' must NOT appear anywhere in the page text");
    assert(audioCheck.badgeText.includes("Archival audio record") || audioCheck.badgeText.includes("Stored sovereignly"), "Archival badge must be preserved");

    console.log("   ✓ <audio controls> element is active and functional.");
    console.log("   ✓ Audio filename element (.exp-audio-filename) is 100% absent from DOM.");
    console.log("   ✓ No audio filename text leaks anywhere in the reader UI.");

    // 4. Dual Narrative Boxes Verification
    console.log("\n4. Verifying Dual Independent Narrative Text Boxes...");
    const boxesCheck = await client.eval(`
      (() => {
        const dualGrid = document.querySelector('.exp-narrative-dual-grid');
        const box1 = document.querySelector('.exp-narrative-box-written');
        const box2 = document.querySelector('.exp-narrative-box-transcribed');

        const box1Tag = box1?.querySelector('.exp-narrative-box-tag')?.textContent?.trim();
        const box1Title = box1?.querySelector('.exp-narrative-box-title')?.textContent?.trim();
        const box1Text = box1?.querySelector('.exp-narrative-box-body')?.textContent?.trim();

        const box2Tag = box2?.querySelector('.exp-narrative-box-tag')?.textContent?.trim();
        const box2Title = box2?.querySelector('.exp-narrative-box-title')?.textContent?.trim();
        const box2Text = box2?.querySelector('.exp-narrative-box-body')?.textContent?.trim();

        return {
          hasDualGrid: Boolean(dualGrid),
          hasBox1: Boolean(box1),
          hasBox2: Boolean(box2),
          box1Tag,
          box1Title,
          box1Text,
          box2Tag,
          box2Title,
          box2Text,
        };
      })()
    `);

    assert(boxesCheck.hasDualGrid, "Must render .exp-narrative-dual-grid container");
    assert(boxesCheck.hasBox1, "Must render Text Box 1 (.exp-narrative-box-written)");
    assert(boxesCheck.hasBox2, "Must render Text Box 2 (.exp-narrative-box-transcribed)");

    assert.strictEqual(boxesCheck.box1Tag, "Text Output 1");
    assert.strictEqual(boxesCheck.box1Title, "Written Story Context");
    assert(boxesCheck.box1Text.includes("Every Thursday my grandmother, Nirmala Devi, made khechedi"));

    assert.strictEqual(boxesCheck.box2Tag, "Text Output 2");
    assert.strictEqual(boxesCheck.box2Title, "Transcribed Audio Narrative");
    assert(boxesCheck.box2Text.includes("ପ୍ରତି ଗୁରୁବାର ମାଟି ହାଣ୍ଡିରେ ମୁଗ ଡାଲି"));

    // Verify STRICT independence: no leakage between the two boxes
    assert(!boxesCheck.box1Text.includes("ପ୍ରତି ଗୁରୁବାର"), "Text Box 1 must NOT contain transcribed speech text");
    assert(!boxesCheck.box2Text.includes("Every Thursday"), "Text Box 2 must NOT contain written context text");

    console.log("   ✓ Text Box 1 verified: 'Text Output 1' / 'Written Story Context'.");
    console.log("   ✓ Text Box 2 verified: 'Text Output 2' / 'Transcribed Audio Narrative'.");
    console.log("   ✓ Strict independence confirmed: zero text mixing or cross-contamination.");

    // 5. Responsive Behavior Check
    console.log("\n5. Verifying Responsive Layout on Desktop vs Mobile...");
    // Desktop Viewport (1280x800)
    await client.send("Emulation.setDeviceMetricsOverride", {
      width: 1280,
      height: 800,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await sleep(500);

    const desktopCols = await client.eval(`
      (() => {
        const grid = document.querySelector('.exp-narrative-dual-grid');
        return window.getComputedStyle(grid).getPropertyValue('grid-template-columns');
      })()
    `);
    console.log(`   • Desktop grid computed columns: ${desktopCols}`);
    assert(desktopCols.split(" ").length === 2, `Desktop layout must compute to 2 columns, got: ${desktopCols}`);

    // Mobile Viewport (375x667)
    await client.send("Emulation.setDeviceMetricsOverride", {
      width: 375,
      height: 667,
      deviceScaleFactor: 2,
      mobile: true,
    });
    await sleep(500);

    const mobileCols = await client.eval(`
      (() => {
        const grid = document.querySelector('.exp-narrative-dual-grid');
        return window.getComputedStyle(grid).getPropertyValue('grid-template-columns');
      })()
    `);
    console.log(`   • Mobile grid computed columns: ${mobileCols}`);
    assert(mobileCols.split(" ").length === 1, `Mobile layout must compute to 1 column, got: ${mobileCols}`);

    console.log("   ✓ Responsive layout verified: 2 side-by-side columns on desktop, 1 stacked column on mobile.");

    console.log("\n=== ALL REAL BROWSER CDP VERIFICATION CHECKS PASSED (100%) ===");
  } catch (err) {
    console.error("FAIL:", err);
    process.exitCode = 1;
  } finally {
    if (client) client.close();
    chromeProc.kill("SIGTERM");
    if (appServer) appServer.close();
    try {
      fs.rmSync(tempProfile, { recursive: true, force: true });
    } catch {}
  }
})();
