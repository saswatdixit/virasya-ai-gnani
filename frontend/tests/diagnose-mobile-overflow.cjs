const { spawn } = require("child_process");
const http = require("http");
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
        res.end("500 Internal Error");
        return;
      }
      res.writeHead(200, { "Content-Type": contentType });
      res.end(content);
    });
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      resolve({ server, port });
    });
  });
}

const VIEWPORTS = [320, 360, 375, 390, 412, 430, 768, 1024, 1280];
const ROUTES = [
  "/",
  "/preserve-your-story",
  "/preserve-your-story/voice",
  "/preserve-your-story/review",
  "/preserve-your-story/vocabulary",
  "/preserve-your-story/punctuation",
  "/preserve-your-story/final-review",
  "/explore",
  "/my-archive",
];

(async () => {
  const distDir = path.join(__dirname, "../dist");
  if (!fs.existsSync(distDir)) {
    console.error("Please run build first!");
    process.exit(1);
  }

  const { server, port } = await startStaticServer(distDir);
  const baseUrl = `http://127.0.0.1:${port}`;
  console.log(`Static server running at ${baseUrl}`);

  const chromePath = findChromePath();
  const cdpPort = 9222 + Math.floor(Math.random() * 500);
  const chromeProcess = spawn(chromePath, [
    "--headless=new",
    `--remote-debugging-port=${cdpPort}`,
    "--no-sandbox",
    "--disable-gpu",
    "--disable-dev-shm-usage",
    "about:blank",
  ]);

  let cdp = null;
  try {
    let targets = null;
    for (let i = 0; i < 30; i++) {
      try {
        targets = await getJson(`http://127.0.0.1:${cdpPort}/json`);
        if (targets && targets.length > 0) break;
      } catch {}
      await new Promise((r) => setTimeout(r, 200));
    }

    const pageTarget = targets.find((t) => t.type === "page") || targets[0];
    cdp = new CDPClient(pageTarget.webSocketDebuggerUrl);
    await cdp.send("Page.enable");
    await cdp.send("DOM.enable");

    console.log("\n=== Checking Horizontal Overflows Across Viewports & Routes ===\n");

    const overflowReports = [];

    for (const route of ROUTES) {
      console.log(`\n--- Inspecting Route: ${route} ---`);
      await cdp.send("Page.navigate", { url: `${baseUrl}${route}` });
      await new Promise((r) => setTimeout(r, 600));

      for (const width of VIEWPORTS) {
        await cdp.send("Emulation.setDeviceMetricsOverride", {
          width,
          height: 800,
          deviceScaleFactor: 1,
          mobile: width < 768,
        });
        await new Promise((r) => setTimeout(r, 100));

        const info = await cdp.eval(`
          (() => {
            const clientWidth = document.documentElement.clientWidth;
            const scrollWidth = document.documentElement.scrollWidth;
            const overflows = [];

            if (scrollWidth > clientWidth) {
              const allElements = document.querySelectorAll('*');
              for (const el of allElements) {
                const rect = el.getBoundingClientRect();
                if (rect.right > clientWidth + 1) {
                  overflows.push({
                    tag: el.tagName.toLowerCase(),
                    id: el.id,
                    className: el.className && typeof el.className === 'string' ? el.className.trim() : '',
                    rectRight: Math.round(rect.right),
                    rectWidth: Math.round(rect.width),
                    clientWidth: clientWidth,
                    overflow: Math.round(rect.right - clientWidth)
                  });
                }
              }
            }

            return {
              clientWidth,
              scrollWidth,
              isOverflowing: scrollWidth > clientWidth,
              delta: scrollWidth - clientWidth,
              topOverflows: overflows.slice(0, 10)
            };
          })()
        `);

        if (info.isOverflowing) {
          console.log(`[OVERFLOW] ${route} @ ${width}px: scrollWidth=${info.scrollWidth} > clientWidth=${info.clientWidth} (delta: +${info.delta}px)`);
          overflowReports.push({ route, width, ...info });
          for (const off of info.topOverflows.slice(0, 5)) {
            console.log(`   -> <${off.tag} class="${off.className}" id="${off.id}"> right=${off.rectRight}px (overflows by ${off.overflow}px)`);
          }
        } else {
          console.log(`[OK] ${route} @ ${width}px: scrollWidth=${info.scrollWidth} <= clientWidth=${info.clientWidth}`);
        }
      }
    }

    console.log("\n========================================================");
    console.log(`Total Overflow Incidents Detected: ${overflowReports.length}`);
    console.log("========================================================\n");

  } finally {
    if (cdp) cdp.close();
    chromeProcess.kill();
    server.close();
  }
})();
