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

(async () => {
  const distDir = path.join(__dirname, "../dist");
  const { server, port } = await startStaticServer(distDir);
  const baseUrl = `http://127.0.0.1:${port}`;

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

    console.log("=== Testing Interactive Drawers & Modals on Mobile Viewports ===");

    // 1. Explore Page Story Reader Drawer
    console.log("\n1. Testing Explore Story Reader Drawer at all viewports...");
    await cdp.send("Page.navigate", { url: `${baseUrl}/explore` });
    await new Promise((r) => setTimeout(r, 600));

    // Open first story card or demo story
    await cdp.eval(`
      (() => {
        const btn = document.querySelector('button.exp-card') || document.querySelector('.exp-card-btn') || Array.from(document.querySelectorAll('button')).find(b => b.textContent.includes('Explore Preview Stories'));
        if (btn) btn.click();
      })()
    `);
    await new Promise((r) => setTimeout(r, 400));
    // Click demo card if present
    await cdp.eval(`
      (() => {
        const card = document.querySelector('button.exp-card') || document.querySelector('.exp-card');
        if (card) card.click();
      })()
    `);
    await new Promise((r) => setTimeout(r, 400));

    for (const width of VIEWPORTS) {
      await cdp.send("Emulation.setDeviceMetricsOverride", {
        width,
        height: 800,
        deviceScaleFactor: 1,
        mobile: width < 768,
      });
      await new Promise((r) => setTimeout(r, 100));

      const drawerInfo = await cdp.eval(`
        (() => {
          const drawer = document.querySelector('.exp-drawer');
          if (!drawer) return { hasDrawer: false };
          const rect = drawer.getBoundingClientRect();
          const clientWidth = document.documentElement.clientWidth;
          const scrollWidth = document.documentElement.scrollWidth;
          const overflows = [];
          for (const el of drawer.querySelectorAll('*')) {
            const r = el.getBoundingClientRect();
            if (r.right > clientWidth + 1) {
              overflows.push({
                tag: el.tagName.toLowerCase(),
                className: el.className,
                right: Math.round(r.right),
                overflow: Math.round(r.right - clientWidth)
              });
            }
          }
          return {
            hasDrawer: true,
            drawerWidth: Math.round(rect.width),
            drawerRight: Math.round(rect.right),
            clientWidth,
            scrollWidth,
            isOverflowing: scrollWidth > clientWidth || rect.right > clientWidth + 1,
            overflows: overflows.slice(0, 5)
          };
        })()
      `);

      if (drawerInfo.hasDrawer) {
        if (drawerInfo.isOverflowing) {
          console.log(`[DRAWER OVERFLOW] Explore Reader @ ${width}px: drawerRight=${drawerInfo.drawerRight} vs clientWidth=${drawerInfo.clientWidth}`);
          for (const o of drawerInfo.overflows) {
            console.log(`   -> <${o.tag} class="${o.className}"> right=${o.right} (overflow ${o.overflow}px)`);
          }
        } else {
          console.log(`[DRAWER OK] Explore Reader @ ${width}px: width=${drawerInfo.drawerWidth}px within ${drawerInfo.clientWidth}px`);
        }
      }
    }

    // 2. Step 6 Final Review Page (Receipt & Review)
    console.log("\n2. Testing Preserve Step 6 at all viewports...");
    await cdp.send("Page.navigate", { url: `${baseUrl}/preserve-your-story/final-review` });
    await new Promise((r) => setTimeout(r, 600));

    for (const width of VIEWPORTS) {
      await cdp.send("Emulation.setDeviceMetricsOverride", {
        width,
        height: 800,
        deviceScaleFactor: 1,
        mobile: width < 768,
      });
      await new Promise((r) => setTimeout(r, 100));

      const step6Info = await cdp.eval(`
        (() => {
          const clientWidth = document.documentElement.clientWidth;
          const scrollWidth = document.documentElement.scrollWidth;
          const overflows = [];
          if (scrollWidth > clientWidth) {
            for (const el of document.querySelectorAll('*')) {
              const r = el.getBoundingClientRect();
              if (r.right > clientWidth + 1) {
                overflows.push({ tag: el.tagName.toLowerCase(), className: el.className, right: Math.round(r.right) });
              }
            }
          }
          return { clientWidth, scrollWidth, isOverflowing: scrollWidth > clientWidth, overflows: overflows.slice(0, 5) };
        })()
      `);

      if (step6Info.isOverflowing) {
        console.log(`[STEP 6 OVERFLOW] @ ${width}px: scrollWidth=${step6Info.scrollWidth} > ${step6Info.clientWidth}`);
        for (const o of step6Info.overflows) console.log(`   -> <${o.tag} class="${o.className}"> right=${o.right}`);
      } else {
        console.log(`[STEP 6 OK] @ ${width}px: scrollWidth=${step6Info.scrollWidth} <= ${step6Info.clientWidth}`);
      }
    }

    // 3. Mobile Navigation Menu
    console.log("\n3. Testing Mobile Menu drawer at all mobile viewports...");
    await cdp.send("Page.navigate", { url: `${baseUrl}/` });
    await new Promise((r) => setTimeout(r, 600));

    for (const width of [320, 360, 375, 390, 412, 430]) {
      await cdp.send("Emulation.setDeviceMetricsOverride", {
        width,
        height: 800,
        deviceScaleFactor: 1,
        mobile: true,
      });
      await new Promise((r) => setTimeout(r, 100));

      // Open mobile menu
      await cdp.eval(`
        (() => {
          const menuBtn = document.querySelector('button.menu-button');
          if (menuBtn) menuBtn.click();
        })()
      `);
      await new Promise((r) => setTimeout(r, 200));

      const menuInfo = await cdp.eval(`
        (() => {
          const menu = document.querySelector('.mobile-menu') || document.querySelector('.mobile-nav');
          const clientWidth = document.documentElement.clientWidth;
          const scrollWidth = document.documentElement.scrollWidth;
          return { hasMenu: Boolean(menu), clientWidth, scrollWidth, isOverflowing: scrollWidth > clientWidth };
        })()
      `);
      console.log(`[MOBILE MENU ${menuInfo.isOverflowing ? 'OVERFLOW' : 'OK'}] @ ${width}px: scrollWidth=${menuInfo.scrollWidth} <= ${menuInfo.clientWidth}`);
    }

    // 4. Auth Modal
    console.log("\n4. Testing Auth Modal on mobile viewports...");
    for (const width of [320, 360, 375, 430]) {
      await cdp.send("Emulation.setDeviceMetricsOverride", {
        width,
        height: 800,
        deviceScaleFactor: 1,
        mobile: true,
      });
      await new Promise((r) => setTimeout(r, 100));

      await cdp.eval(`
        (() => {
          const profBtn = document.querySelector('.nav-profile');
          if (profBtn) profBtn.click();
        })()
      `);
      await new Promise((r) => setTimeout(r, 200));

      const modalInfo = await cdp.eval(`
        (() => {
          const modal = document.querySelector('.auth-modal-dialog') || document.querySelector('.auth-modal');
          const clientWidth = document.documentElement.clientWidth;
          const scrollWidth = document.documentElement.scrollWidth;
          if (!modal) return { hasModal: false };
          const rect = modal.getBoundingClientRect();
          return {
            hasModal: true,
            modalWidth: Math.round(rect.width),
            modalRight: Math.round(rect.right),
            clientWidth,
            isOverflowing: rect.right > clientWidth + 1 || scrollWidth > clientWidth
          };
        })()
      `);
      if (modalInfo.hasModal) {
        console.log(`[AUTH MODAL ${modalInfo.isOverflowing ? 'OVERFLOW' : 'OK'}] @ ${width}px: modalWidth=${modalInfo.modalWidth} within ${modalInfo.clientWidth}`);
      }
    }

  } finally {
    if (cdp) cdp.close();
    chromeProcess.kill();
    server.close();
  }
})();
