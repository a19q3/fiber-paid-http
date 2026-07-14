import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { createServer as createHttpServer } from "node:http";
import { readFile } from "node:fs/promises";

const here = dirname(fileURLToPath(import.meta.url));
const distPath = resolve(here, "..", "dist");
const htmlPath = resolve(distPath, "index.html");
const screenshotDir = resolve(tmpdir(), "fiber-paid-http-layout-check");
const viewports = [
  { width: 1440, height: 1100 },
  { width: 1280, height: 1100 },
  { width: 1200, height: 1100 },
  { width: 1160, height: 1100 },
  { width: 1120, height: 1100 },
  { width: 1024, height: 1100 },
  { width: 760, height: 1200 },
  { width: 390, height: 1500 }
];
const maxAllowedTabJitterPx = 1;
const expectedPanels = {
  overview: ["overview"],
  flow: ["request", "timeline"],
  bootstrap: ["bootstrap"],
  evidence: ["parity", "evidence"],
  attacks: ["attacks"],
  network: ["network"],
  tournament: ["example-capabilities", "example-input", "example-evidence", "example-match"]
};

const chromeBin = process.env.CHROME_BIN || await findChrome();
if (!chromeBin) {
  throw new Error("Chrome not found. Set CHROME_BIN or install google-chrome-stable/chromium.");
}

const port = await findFreePort();
const serverPort = await findFreePort();
const fileTypes = new Map([
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".svg", "image/svg+xml"],
  [".json", "application/json; charset=utf-8"]
]);
const httpServer = createHttpServer(async (req, res) => {
  const url = new URL(req.url || "/", "http://127.0.0.1");
  let pathname = url.pathname === "/" ? "/index.html" : url.pathname;
  const filePath = resolve(distPath, pathname.slice(1));
  try {
    const body = await readFile(filePath);
    res.writeHead(200, { "content-type": fileTypes.get(filePath.split(".").pop() ? "." + filePath.split(".").pop() : "") || "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
  }
});
await new Promise((resolveListen) => httpServer.listen(serverPort, resolveListen));
const htmlUrl = `http://127.0.0.1:${serverPort}/`;
const profileDir = await mkdtemp(resolve(tmpdir(), "fiber-paid-http-layout-profile-"));
const chrome = spawn(chromeBin, [
  "--headless=new",
  `--remote-debugging-port=${port}`,
  "--no-sandbox",
  "--disable-gpu",
  "--window-size=1440,1100",
  `--user-data-dir=${profileDir}`,
  htmlUrl
], { stdio: ["ignore", "pipe", "pipe"] });

try {
  await waitForDebugger(port);
  const page = await firstPage(port);
  const client = await connectCdp(page.webSocketDebuggerUrl);
  try {
    await client.send("Page.enable");
    await client.send("Runtime.enable");
    await client.send("Page.reload", { ignoreCache: true });
    await client.evaluate("new Promise((resolve) => setTimeout(resolve, 2500))");
    await runLayoutChecks(client);
  } finally {
    client.close();
  }
} finally {
    httpServer.close();
    chrome.kill("SIGTERM");
    await waitForProcessExit(chrome);
  await rm(profileDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
}

console.log(`evidence console layout checks passed: ${viewports.length} viewports, tab jitter stable across all checked viewports`);

async function runLayoutChecks(client) {
  const failures = [];
  await rm(screenshotDir, { recursive: true, force: true });
  await mkdir(screenshotDir, { recursive: true });
  for (const viewport of viewports) {
    await client.send("Emulation.setDeviceMetricsOverride", {
      width: viewport.width,
      height: viewport.height,
      deviceScaleFactor: 1,
      mobile: false
    });
    await client.evaluate("new Promise((resolve) => setTimeout(resolve, 350))");
    for (const tab of Object.keys(expectedPanels)) {
      await client.evaluate(`document.querySelector('[data-workspace-tab="${tab}"]').click()`);
      await client.evaluate("new Promise((resolve) => setTimeout(resolve, 250))");
      const metrics = await client.evaluate(layoutMetricsExpression());
      const expected = expectedPanels[tab].join(",");
      const actual = metrics.visible.join(",");
      if (actual !== expected) {
        failures.push(`${viewport.width}:${tab} visible panels ${actual}; expected ${expected}`);
      }
      if (metrics.scrollWidth > metrics.innerWidth + 1) {
        failures.push(`${viewport.width}:${tab} horizontal overflow ${metrics.scrollWidth} > ${metrics.innerWidth}`);
      }
      if (metrics.offenders.length) {
        failures.push(`${viewport.width}:${tab} overflow offenders ${JSON.stringify(metrics.offenders)}`);
      }
    }
    await client.evaluate("document.querySelector('.app-header .icon-btn:last-child')?.click()");
    await client.evaluate("new Promise((resolve) => setTimeout(resolve, 250))");
    const settingsMetrics = await client.evaluate(layoutMetricsExpression());
    if (settingsMetrics.scrollWidth > settingsMetrics.innerWidth + 1) {
      failures.push(`${viewport.width}:settings horizontal overflow ${settingsMetrics.scrollWidth} > ${settingsMetrics.innerWidth}`);
    }
    await client.evaluate("document.querySelector('.settings-close, .icon-btn[aria-label=\"Close settings\"]')?.click()");
  }

  for (const viewport of viewports) {
    await client.send("Emulation.setDeviceMetricsOverride", {
      width: viewport.width,
      height: viewport.height,
      deviceScaleFactor: 1,
      mobile: false
    });
    await client.evaluate("document.querySelector('[data-workspace-tab=\"flow\"]')?.click()");
    await client.evaluate("new Promise((resolve) => setTimeout(resolve, 300))");
    const evidenceTabsContainerWorkspaceJitter = await client.evaluate(tabJitterExpression(".evidence-tabs", "document.querySelector('[data-workspace-tab=\"evidence\"]')?.click()"));
    recordJitterFailures(failures, `evidence-tabs-container-workspace-${viewport.width}`, evidenceTabsContainerWorkspaceJitter, { position: false });

    await client.evaluate("new Promise((resolve) => setTimeout(resolve, 300))");
    await client.evaluate("document.querySelector('[data-workspace-tab=\"flow\"]')?.click()");
    await client.evaluate("new Promise((resolve) => setTimeout(resolve, 300))");
    const evidenceRailWorkspaceJitter = await client.evaluate(tabJitterExpression(".evidence-tabs .tab-btn", "document.querySelector('[data-workspace-tab=\"evidence\"]')?.click()"));
    recordJitterFailures(failures, `evidence-rail-workspace-${viewport.width}`, evidenceRailWorkspaceJitter, { position: false });

    await client.evaluate("new Promise((resolve) => setTimeout(resolve, 300))");
    await client.evaluate("document.querySelector('[data-workspace-tab=\"flow\"]')?.click()");
    await client.evaluate("new Promise((resolve) => setTimeout(resolve, 300))");
    const workspaceJitter = await client.evaluate(tabJitterExpression(".nav-item", "document.querySelector('[data-workspace-tab=\"evidence\"]')?.click()"));
    recordJitterFailures(failures, `workspace-${viewport.width}`, workspaceJitter, { position: true });

    await client.evaluate("new Promise((resolve) => setTimeout(resolve, 300))");
    await client.evaluate("document.querySelector('[data-workspace-tab=\"evidence\"]')?.click()");
    await client.evaluate("new Promise((resolve) => setTimeout(resolve, 300))");
    const evidenceJitter = await client.evaluate(tabJitterExpression(".evidence-tabs .tab-btn", "Array.from(document.querySelectorAll('.evidence-tabs .tab-btn'))[1]?.click()"));
    recordJitterFailures(failures, `evidence-tabs-${viewport.width}`, evidenceJitter, { position: true });

    await client.evaluate("new Promise((resolve) => setTimeout(resolve, 300))");
    const evidenceTabsContainerJitter = await client.evaluate(tabJitterExpression(".evidence-tabs", "Array.from(document.querySelectorAll('.evidence-tabs .tab-btn'))[2]?.click()"));
    recordJitterFailures(failures, `evidence-tabs-container-${viewport.width}`, evidenceTabsContainerJitter, { position: true });
  }

  for (const viewport of viewports.filter(({ width }) => width <= 767)) {
    await client.send("Emulation.setDeviceMetricsOverride", {
      width: viewport.width,
      height: viewport.height,
      deviceScaleFactor: 1,
      mobile: false
    });
    await client.evaluate("new Promise((resolve) => setTimeout(resolve, 250))");
    const mobileNavBefore = await client.evaluate(mobileNavigationExpression());
    if (mobileNavBefore.visible || mobileNavBefore.expanded) {
      failures.push(`${viewport.width}: mobile navigation must start closed ${JSON.stringify(mobileNavBefore)}`);
    }
    await client.evaluate("document.querySelector('#toggle-navigation')?.click()");
    await client.evaluate("new Promise((resolve) => setTimeout(resolve, 250))");
    const mobileNavOpen = await client.evaluate(mobileNavigationExpression());
    if (!mobileNavOpen.visible || !mobileNavOpen.expanded) {
      failures.push(`${viewport.width}: mobile navigation did not open ${JSON.stringify(mobileNavOpen)}`);
    }
    await client.evaluate("document.querySelector('[data-workspace-tab=\"evidence\"]')?.click()");
    await client.evaluate("new Promise((resolve) => setTimeout(resolve, 250))");
    const mobileNavAfter = await client.evaluate(mobileNavigationExpression());
    if (mobileNavAfter.visible || mobileNavAfter.expanded || mobileNavAfter.workspace !== "evidence") {
      failures.push(`${viewport.width}: mobile navigation did not navigate and close ${JSON.stringify(mobileNavAfter)}`);
    }
  }

  await client.send("Emulation.setDeviceMetricsOverride", {
    width: 1024,
    height: 1100,
    deviceScaleFactor: 1,
    mobile: false
  });
  await client.evaluate("document.querySelector('#close-inspector')?.click()");
  await client.evaluate("document.querySelector('[aria-label=\"Open preferences\"]')?.click()");
  await client.evaluate(`Array.from(document.querySelectorAll('.popover .toggle-btn')).find((button) => button.textContent.trim() === 'Hidden')?.click()`);
  await client.evaluate("new Promise((resolve) => setTimeout(resolve, 250))");
  const inspectorOpen = await client.evaluate(inspectorVisibilityExpression());
  if (!inspectorOpen.visible || !inspectorOpen.openClass) {
    failures.push(`1024: inspector preference did not open the responsive panel ${JSON.stringify(inspectorOpen)}`);
  }
  await client.evaluate("document.querySelector('#close-inspector')?.click()");
  await client.evaluate("new Promise((resolve) => setTimeout(resolve, 250))");
  const inspectorClosed = await client.evaluate(inspectorVisibilityExpression());
  if (inspectorClosed.visible || inspectorClosed.openClass) {
    failures.push(`1024: inspector close control did not hide the responsive panel ${JSON.stringify(inspectorClosed)}`);
  }

  const screenshot = await client.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false, fromSurface: true });
  await writeFile(resolve(screenshotDir, "layout-check-final.png"), Buffer.from(screenshot.data, "base64"));

  if (failures.length) {
    throw new Error(`Layout check failed:\n- ${failures.join("\n- ")}`);
  }
}

function recordJitterFailures(failures, label, result, options = {}) {
  if (result.clientWidthDelta > maxAllowedTabJitterPx) {
    failures.push(`${label}: root clientWidth jitter ${result.clientWidthDelta}px`);
  }
  if (result.bodyWidthDelta > maxAllowedTabJitterPx) {
    failures.push(`${label}: body width jitter ${result.bodyWidthDelta}px`);
  }
  for (const item of result.deltas) {
    const positionJitter = options.position && (item.dx > maxAllowedTabJitterPx || item.dy > maxAllowedTabJitterPx);
    if (positionJitter || item.dw > maxAllowedTabJitterPx || item.dh > maxAllowedTabJitterPx) {
      failures.push(`${label}:${item.text} jitter dx=${item.dx} dy=${item.dy} dw=${item.dw} dh=${item.dh}`);
    }
  }
}

function layoutMetricsExpression() {
  return `(() => {
    const root = document.documentElement;
    const body = document.body;
    const visible = Array.from(document.querySelectorAll('.app-main .panel, .app-main [data-panel-id]'))
      .filter((node) => getComputedStyle(node).display !== 'none' && node.dataset.panelId)
      .map((node) => node.dataset.panelId);
    const offenders = Array.from(document.querySelectorAll('body *'))
      .filter((node) => {
        const style = getComputedStyle(node);
        if (style.display === 'none' || style.visibility === 'hidden') {
          return false;
        }
        const rect = node.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0 && (rect.right > innerWidth + 1 || rect.left < -1);
      })
      .slice(0, 8)
      .map((node) => ({
        tag: node.tagName,
        id: node.id,
        cls: String(node.className).slice(0, 80),
        left: Math.round(node.getBoundingClientRect().left),
        right: Math.round(node.getBoundingClientRect().right),
        width: Math.round(node.getBoundingClientRect().width)
      }));
    return { innerWidth, scrollWidth: Math.max(root.scrollWidth, body.scrollWidth), visible, offenders };
  })()`;
}

function mobileNavigationExpression() {
  return `(() => {
    const nav = document.querySelector('#workspace-navigation');
    const style = nav ? getComputedStyle(nav) : null;
    const rect = nav?.getBoundingClientRect();
    return {
      visible: Boolean(nav && style?.visibility !== 'hidden' && rect && rect.right > 0),
      expanded: document.querySelector('#toggle-navigation')?.getAttribute('aria-expanded') === 'true',
      workspace: document.querySelector('.console')?.dataset.workspace || ''
    };
  })()`;
}

function inspectorVisibilityExpression() {
  return `(() => {
    const inspector = document.querySelector('.app-inspector');
    return {
      visible: Boolean(inspector && getComputedStyle(inspector).display !== 'none'),
      openClass: document.querySelector('.app-body')?.classList.contains('inspector-open') === true
    };
  })()`;
}

function tabJitterExpression(selector, clickExpression) {
  return `(async () => {
    const rects = () => Array.from(document.querySelectorAll(${JSON.stringify(selector)})).map((node) => {
      const rect = node.getBoundingClientRect();
      return {
        text: node.textContent.trim().replace(/\\s+/g, ' '),
        x: +rect.x.toFixed(3),
        y: +rect.y.toFixed(3),
        w: +rect.width.toFixed(3),
        h: +rect.height.toFixed(3)
      };
    });
    const rootWidth = () => document.documentElement.clientWidth;
    const bodyWidth = () => +document.body.getBoundingClientRect().width.toFixed(3);
    const frames = [rects()];
    const rootWidths = [rootWidth()];
    const bodyWidths = [bodyWidth()];
    ${clickExpression};
    for (let i = 0; i < 14; i += 1) {
      await new Promise(requestAnimationFrame);
      frames.push(rects());
      rootWidths.push(rootWidth());
      bodyWidths.push(bodyWidth());
    }
    return {
      clientWidthDelta: +(Math.max(...rootWidths) - Math.min(...rootWidths)).toFixed(3),
      bodyWidthDelta: +(Math.max(...bodyWidths) - Math.min(...bodyWidths)).toFixed(3),
      deltas: frames[0].map((first, index) => {
        const widths = frames.map((frame) => frame[index]?.w ?? 0);
        const heights = frames.map((frame) => frame[index]?.h ?? 0);
        const xs = frames.map((frame) => frame[index]?.x ?? 0);
        const ys = frames.map((frame) => frame[index]?.y ?? 0);
        return {
          text: first.text,
          dx: +(Math.max(...xs) - Math.min(...xs)).toFixed(3),
          dy: +(Math.max(...ys) - Math.min(...ys)).toFixed(3),
          dw: +(Math.max(...widths) - Math.min(...widths)).toFixed(3),
          dh: +(Math.max(...heights) - Math.min(...heights)).toFixed(3)
        };
      })
    };
  })()`;
}

async function firstPage(port) {
  const pages = await fetch(`http://127.0.0.1:${port}/json/list`).then((response) => response.json());
  const page = pages.find((item) => item.type === "page");
  if (!page) {
    throw new Error("Chrome did not expose a page target");
  }
  return page;
}

async function connectCdp(url) {
  const ws = new WebSocket(url);
  let id = 0;
  const pending = new Map();
  ws.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      const callbacks = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) {
        callbacks.reject(new Error(JSON.stringify(message.error)));
      } else {
        callbacks.resolve(message.result);
      }
    }
  });
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener("error", reject, { once: true });
  });
  return {
    send(method, params = {}) {
      const next = ++id;
      ws.send(JSON.stringify({ id: next, method, params }));
      return new Promise((resolve, reject) => pending.set(next, { resolve, reject }));
    },
    evaluate(expression) {
      return this.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true })
        .then((result) => {
          if (result.exceptionDetails) {
            throw new Error(JSON.stringify(result.exceptionDetails));
          }
          return result.result.value;
        });
    },
    close() {
      ws.close();
    }
  };
}

async function waitForDebugger(port) {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (response.ok) return;
    } catch {
      // Retry until Chrome opens the debugging endpoint.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Timed out waiting for Chrome debugging endpoint");
}

async function findFreePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  await new Promise((resolve) => server.close(resolve));
  return address.port;
}

async function findChrome() {
  const candidates = [
    "google-chrome-stable",
    "google-chrome",
    "chromium",
    "chromium-browser",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"
  ];
  for (const candidate of candidates) {
    if (await commandExists(candidate)) return candidate;
  }
  return "";
}

function commandExists(command) {
  return new Promise((resolve) => {
    const child = spawn("sh", ["-lc", "command -v \"$1\" >/dev/null 2>&1 || [ -x \"$1\" ]", "sh", command], { stdio: "ignore" });
    child.on("exit", (code) => resolve(code === 0));
    child.on("error", () => resolve(false));
  });
}

function waitForProcessExit(child) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, 2000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}
