"use strict";

const { app, BrowserWindow, ipcMain, dialog, session, safeStorage } = require("electron");
const path = require("path");
const fs = require("fs");
const os = require("os");
const net = require("net");

const isDev = !app.isPackaged;
const PROXY_PROBE_URL = "https://api.openai.com/v1/models";

let overlayWin = null;
let mainWin = null;
let proxyAuth = null;
let proxyDiagnostics = {
  checkedAt: null,
  candidates: [],
  selectedPath: null,
  selectedConfig: null,
  applyAttempted: false,
  applySucceeded: false,
  resolvedProxy: null,
  authConfigured: false,
  warnings: [],
  error: null,
  userDataConfigPath: null,
  rawSocketTest: null,
};

const PROXY_SOCKET_TIMEOUT_MS = 5000;

// Independent low-level TCP check to the proxy host:port, bypassing Chromium's
// network stack entirely (uses Node's own sockets, same as `curl`/OS tools).
// This helps tell apart "Chromium/Electron can't reach the proxy" (e.g. this
// process is blocked by a firewall/antivirus rule, while curl.exe is allowed)
// from "the proxy is reachable but auth/tunnel to the target fails".
function testRawSocketConnection(host, port) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const socket = net.connect({ host, port, timeout: PROXY_SOCKET_TIMEOUT_MS });
    let settled = false;
    const finish = (success, error) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve({
        success,
        error: error || null,
        durationMs: Date.now() - startedAt,
      });
    };
    socket.once("connect", () => finish(true, null));
    socket.once("timeout", () => finish(false, `timeout after ${PROXY_SOCKET_TIMEOUT_MS}ms`));
    socket.once("error", (e) => finish(false, e?.code || e?.message || String(e)));
  });
}

function readJsonIfExists(fp) {
  try {
    if (!fp || !fs.existsSync(fp)) return null;
    const raw = fs.readFileSync(fp, "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function ensurePackagedProxyConfig(userDataConfigPath) {
  if (!app.isPackaged || !userDataConfigPath || fs.existsSync(userDataConfigPath)) {
    return { created: false, warning: null };
  }

  const bundledExamplePath = path.join(__dirname, "proxy.config.example.json");
  if (!fs.existsSync(bundledExamplePath)) {
    return { created: false, warning: null };
  }

  try {
    fs.mkdirSync(path.dirname(userDataConfigPath), { recursive: true });
    fs.copyFileSync(bundledExamplePath, userDataConfigPath);
    return {
      created: true,
      warning: `Created proxy config template at ${userDataConfigPath}. Fill it in and set enabled=true.`,
    };
  } catch (e) {
    return {
      created: false,
      warning: `Could not create proxy config template at ${userDataConfigPath}: ${e?.message || String(e)}`,
    };
  }
}

function loadProxyConfig() {
  const explicitConfigPath = process.env.RT_PROXY_CONFIG;
  const userDataConfigPath = path.join(app.getPath("userData"), "proxy.config.json");
  const bootstrap = ensurePackagedProxyConfig(userDataConfigPath);
  const candidatePaths = app.isPackaged
    ? [explicitConfigPath, userDataConfigPath]
    : [
        explicitConfigPath,
        userDataConfigPath,
        path.join(__dirname, "proxy.config.local.json"),
        path.join(__dirname, "proxy.config.example.json"),
      ];

  const candidates = candidatePaths.filter(Boolean).map((fp) => {
    if (!fs.existsSync(fp)) return { path: fp, exists: false, validJson: false, enabled: null };
    const parsed = readJsonIfExists(fp);
    if (!parsed) return { path: fp, exists: true, validJson: false, enabled: null };
    return {
      path: fp,
      exists: true,
      validJson: true,
      enabled: Boolean(parsed.enabled),
      parsed,
    };
  });

  const warnings = [];
  if (bootstrap.warning) warnings.push(bootstrap.warning);
  const parsedCandidates = candidates.filter((x) => x.validJson);
  let selected = parsedCandidates[0] || null;
  const firstEnabled = parsedCandidates.find((x) => x.enabled);
  if (selected && !selected.enabled && firstEnabled && selected.path !== firstEnabled.path) {
    warnings.push(
      `Higher-priority config is disabled (${selected.path}), switching to enabled config (${firstEnabled.path}).`,
    );
    selected = firstEnabled;
  }
  if (app.isPackaged && selected && selected.path !== userDataConfigPath && selected.path !== explicitConfigPath) {
    warnings.push(`Ignoring packaged proxy config path: ${selected.path}`);
    selected = null;
  }
  if (app.isPackaged && !selected) {
    warnings.push(
      `Packaged app expects proxy config at ${userDataConfigPath} or RT_PROXY_CONFIG.`,
    );
  }

  return {
    config: selected?.parsed || null,
    selectedPath: selected?.path || null,
    userDataConfigPath,
    candidates: candidates.map((x) => ({
      path: x.path,
      exists: x.exists,
      validJson: x.validJson,
      enabled: x.enabled,
    })),
    warnings,
  };
}

async function configureProxy(sess) {
  const loaded = loadProxyConfig();
  const cfg = loaded.config;
  proxyDiagnostics = {
    checkedAt: new Date().toISOString(),
    candidates: loaded.candidates,
    selectedPath: loaded.selectedPath,
    selectedConfig: sanitizeProxyConfig(cfg),
    applyAttempted: false,
    applySucceeded: false,
    resolvedProxy: null,
    authConfigured: false,
    warnings: [...loaded.warnings],
    error: null,
    userDataConfigPath: loaded.userDataConfigPath,
  };

  if (!cfg) {
    proxyDiagnostics.warnings.push("No valid proxy config JSON found.");
    console.warn("[proxy] No valid proxy config JSON found in candidate paths.");
    return;
  }

  console.log(
    `[proxy] Config selected: ${loaded.selectedPath || "<none>"} enabled=${Boolean(cfg.enabled)}`,
  );
  if (!cfg.enabled) {
    proxyDiagnostics.warnings.push(
      `Selected proxy config is disabled (${loaded.selectedPath || "<unknown>"}).`,
    );
    return;
  }

  const protocol = String(cfg.protocol || "http").toLowerCase();
  const host = String(cfg.host || "").trim();
  const port = Number(cfg.port);
  if (!host || !Number.isFinite(port) || port <= 0) {
    proxyDiagnostics.error = "Invalid proxy host/port in selected config.";
    return;
  }

  // For SOCKS5 (and other protocols), embed credentials directly in the URL.
  // The app.on('login') event handles HTTP proxy auth (407), but SOCKS5 auth
  // happens at the protocol level and requires credentials in the proxy URL.
  const username = String(cfg.username || "").trim();
  const password = String(cfg.password || "");
  const auth = username ? `${encodeURIComponent(username)}:${encodeURIComponent(password)}@` : "";
  const redactedAuth = username ? `${encodeURIComponent(username)}:***@` : "";
  const proxyRules = `${protocol}://${auth}${host}:${port}`;
  const proxyRulesForDiagnostics = `${protocol}://${redactedAuth}${host}:${port}`;
  const proxyBypassRules =
    Array.isArray(cfg.bypass) && cfg.bypass.length > 0
      ? cfg.bypass.map((x) => String(x).trim()).filter(Boolean).join(";")
      : "<local>";

  proxyDiagnostics.applyAttempted = true;
  await sess.setProxy({
    proxyRules,
    proxyBypassRules,
  });
  proxyDiagnostics.applySucceeded = true;
  proxyDiagnostics.proxyRules = proxyRulesForDiagnostics;
  proxyDiagnostics.proxyBypassRules = proxyBypassRules;

  proxyDiagnostics.rawSocketTest = await testRawSocketConnection(host, port);
  if (!proxyDiagnostics.rawSocketTest.success) {
    proxyDiagnostics.warnings.push(
      `Raw TCP connection to proxy ${host}:${port} failed: ${proxyDiagnostics.rawSocketTest.error}. ` +
        `If this proxy is reachable from the same machine via curl/other tools, this app's ` +
        `process (Realtime Transcriber.exe) is likely blocked by a firewall/antivirus rule.`,
    );
    console.error(
      `[proxy] Raw TCP test to ${host}:${port} FAILED: ${proxyDiagnostics.rawSocketTest.error}`,
    );
  } else {
    console.log(
      `[proxy] Raw TCP test to ${host}:${port} succeeded in ${proxyDiagnostics.rawSocketTest.durationMs}ms.`,
    );
  }

  try {
    proxyDiagnostics.resolvedProxy = await sess.resolveProxy(PROXY_PROBE_URL);
    const resolvedUpper = String(proxyDiagnostics.resolvedProxy || "").toUpperCase();
    if (resolvedUpper.includes("DIRECT")) {
      proxyDiagnostics.warnings.push(
        `Resolved route for ${PROXY_PROBE_URL} is DIRECT (${proxyDiagnostics.resolvedProxy}).`,
      );
    }
  } catch (e) {
    proxyDiagnostics.warnings.push(
      `Could not resolve proxy route: ${e?.message || String(e)}`,
    );
  }

  // Keep proxyAuth for the login event fallback (HTTP proxies).
  proxyAuth = username ? { username, password } : null;
  proxyDiagnostics.authConfigured = Boolean(proxyAuth);
}


function sanitizeProxyConfig(cfg) {
  if (!cfg || typeof cfg !== "object") return null;
  return {
    enabled: Boolean(cfg.enabled),
    protocol: String(cfg.protocol || ""),
    host: String(cfg.host || ""),
    port: Number(cfg.port),
    username: String(cfg.username || ""),
    hasPassword: Boolean(String(cfg.password || "")),
    bypassCount: Array.isArray(cfg.bypass) ? cfg.bypass.length : 0,
  };
}

function createWindow() {
  mainWin = new BrowserWindow({
    width: 1100,
    height: 780,
    title: "Realtime Transcriber",
    autoHideMenuBar: true,
    backgroundColor: "#0b0d10",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWin.loadFile(path.join(__dirname, "renderer", "index.html"));

  // Close overlay when the main window closes.
  mainWin.on("closed", () => {
    mainWin = null;
    if (overlayWin && !overlayWin.isDestroyed()) overlayWin.close();
  });

  if (isDev) {
    mainWin.webContents.openDevTools({ mode: "detach" });
  }
}

app.whenReady().then(async () => {
  try {
    await configureProxy(session.defaultSession);
  } catch (e) {
    proxyDiagnostics.error = e?.message || String(e);
    console.error("Failed to configure proxy:", e?.message || e);
  }

  // Log real Chromium network errors (e.g. net::ERR_PROXY_CONNECTION_FAILED,
  // net::ERR_TUNNEL_CONNECTION_FAILED) for OpenAI requests, since fetch() in the
  // renderer only reports a generic "Failed to fetch" with no underlying reason.
  session.defaultSession.webRequest.onErrorOccurred((details) => {
    if (!details?.url?.includes("api.openai.com")) return;
    console.error(
      `[proxy] Network error for ${details.url}: ${details.error} (resourceType=${details.resourceType})`,
    );
  });

  // Allow the renderer to request microphone and desktop audio without extra prompts.
  session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => {
    if (permission === "media") return cb(true);
    cb(false);
  });

  // Loopback (system) audio via getDisplayMedia — provide default loopback source.
  try {
    session.defaultSession.setDisplayMediaRequestHandler(
      (_request, callback) => {
        const { desktopCapturer } = require("electron");
        desktopCapturer
          .getSources({ types: ["screen"] })
          .then((sources) => {
            callback({ video: sources[0], audio: "loopback" });
          })
          .catch(() => callback({}));
      },
      { useSystemPicker: false },
    );
  } catch {
    // Older Electron: fall back to desktopCapturer path in the renderer.
  }

  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("login", (event, _webContents, _request, authInfo, callback) => {
  if (!authInfo?.isProxy || !proxyAuth?.username) return;
  event.preventDefault();
  callback(proxyAuth.username, proxyAuth.password || "");
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

ipcMain.handle("list-desktop-sources", async () => {
  const { desktopCapturer } = require("electron");
  const sources = await desktopCapturer.getSources({
    types: ["screen", "window"],
  });
  return sources.map((s) => ({ id: s.id, name: s.name }));
});

ipcMain.handle("save-transcript", async (_evt, payload) => {
  const { content, defaultName } = payload || {};
  const safeName =
    (defaultName && String(defaultName)) ||
    `Транскрипция_${new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-")}.txt`;

  const win = mainWin || BrowserWindow.getFocusedWindow();
  const res = await dialog.showSaveDialog(win, {
    title: "Сохранить расшифровку",
    defaultPath: path.join(app.getPath("documents"), safeName),
    filters: [{ name: "Text", extensions: ["txt"] }],
  });
  if (res.canceled || !res.filePath) return { saved: false };

  fs.writeFileSync(res.filePath, content, "utf8");
  return { saved: true, path: res.filePath };
});

ipcMain.handle("autosave-transcript", async (_evt, payload) => {
  const { content } = payload || {};
  if (!content) return { saved: false };
  const dir = path.join(app.getPath("userData"), "sessions");
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
  const file = path.join(dir, `session_${stamp}.txt`);
  fs.writeFileSync(file, content, "utf8");
  return { saved: true, path: file };
});

ipcMain.handle("autosave-to-session", async (_evt, payload) => {
  const { filename, content } = payload || {};
  const safeFilename = sanitizeSessionFilename(filename);
  if (!content || !safeFilename) return { saved: false };
  const dir = path.join(app.getPath("userData"), "sessions");
  fs.mkdirSync(dir, { recursive: true });
  const fp = path.join(dir, safeFilename);
  fs.writeFileSync(fp, content, "utf8");
  return { saved: true, path: fp };
});

ipcMain.handle("list-sessions", async () => {
  const dir = path.join(app.getPath("userData"), "sessions");
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".txt"))
    .map((f) => {
      const fp = path.join(dir, f);
      const stat = fs.statSync(fp);
      return { filename: f, size: stat.size, mtime: stat.mtimeMs };
    })
    .sort((a, b) => b.mtime - a.mtime);
});

ipcMain.handle("delete-session", async (_evt, filename) => {
  const safeFilename = sanitizeSessionFilename(filename);
  if (!safeFilename) return { ok: false };
  const dir = path.join(app.getPath("userData"), "sessions");
  const fp = path.join(dir, safeFilename);
  if (fs.existsSync(fp)) fs.unlinkSync(fp);
  return { ok: true };
});

ipcMain.handle("load-session", async (_evt, filename) => {
  const safeFilename = sanitizeSessionFilename(filename);
  if (!safeFilename) return { content: "" };
  const dir = path.join(app.getPath("userData"), "sessions");
  const fp = path.join(dir, safeFilename);
  if (!fs.existsSync(fp)) return { content: "" };
  return { content: fs.readFileSync(fp, "utf8") };
});

ipcMain.handle("get-app-info", () => ({
  version: app.getVersion(),
  platform: process.platform,
  homedir: os.homedir(),
}));

ipcMain.handle("get-proxy-diagnostics", () => ({
  ...proxyDiagnostics,
  candidatePaths: proxyDiagnostics.candidates?.map((x) => x.path) || [],
}));

// -------- secure API key storage --------

function getApiKeyPath() {
  return path.join(app.getPath("userData"), ".apikey");
}

function sanitizeSessionFilename(filename) {
  if (typeof filename !== "string") return null;
  const trimmed = filename.trim();
  if (!trimmed) return null;
  if (trimmed.includes("..")) return null;
  const base = path.basename(trimmed);
  if (base !== trimmed) return null;
  if (/[<>:"/\\|?*\x00-\x1F]/.test(base)) return null;
  if (!base.endsWith(".txt")) return null;
  return base;
}

ipcMain.handle("store-api-key", (_evt, key) => {
  const fp = getApiKeyPath();
  if (!key) {
    if (fs.existsSync(fp)) fs.unlinkSync(fp);
    return;
  }
  if (safeStorage.isEncryptionAvailable()) {
    fs.writeFileSync(fp, safeStorage.encryptString(key));
  } else {
    fs.writeFileSync(fp, key, "utf8");
  }
});

ipcMain.handle("load-api-key", () => {
  const fp = getApiKeyPath();
  if (!fs.existsSync(fp)) return "";
  try {
    const buf = fs.readFileSync(fp);
    if (safeStorage.isEncryptionAvailable()) {
      return safeStorage.decryptString(buf);
    }
    return buf.toString("utf8");
  } catch {
    return "";
  }
});

// -------- overlay window --------

ipcMain.handle("open-overlay", async () => {
  if (overlayWin && !overlayWin.isDestroyed()) {
    overlayWin.focus();
    return;
  }
  overlayWin = new BrowserWindow({
    width: 440,
    height: 320,
    minWidth: 280,
    minHeight: 160,
    title: "Расшифровка",
    alwaysOnTop: true,
    transparent: true,
    frame: false,
    resizable: true,
    skipTaskbar: false,
    hasShadow: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  overlayWin.loadFile(path.join(__dirname, "renderer", "overlay.html"));
  overlayWin.on("closed", () => {
    overlayWin = null;
  });
});

ipcMain.handle("push-transcript-line", (_evt, msg) => {
  if (overlayWin && !overlayWin.isDestroyed()) {
    overlayWin.webContents.send("new-line", msg);
  }
});

ipcMain.handle("clear-lines", () => {
  if (overlayWin && !overlayWin.isDestroyed()) {
    overlayWin.webContents.send("clear-lines");
  }
});

// Forward recording control actions from overlay → main window.
ipcMain.handle("recording-control", async (_evt, action) => {
  if (mainWin && !mainWin.isDestroyed()) {
    mainWin.webContents.send("recording-control", action);
  }
});

// Forward recording state from main window → overlay.
ipcMain.handle("push-recording-state", async (_evt, state) => {
  if (overlayWin && !overlayWin.isDestroyed()) {
    overlayWin.webContents.send("recording-state", state);
  }
});
