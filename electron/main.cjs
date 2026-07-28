"use strict";

const { app, BrowserWindow, ipcMain, dialog, session, safeStorage } = require("electron");
const path = require("path");
const fs = require("fs");
const os = require("os");

const isDev = !app.isPackaged;

let overlayWin = null;
let mainWin = null;
let proxyAuth = null;

function readJsonIfExists(fp) {
  try {
    if (!fp || !fs.existsSync(fp)) return null;
    const raw = fs.readFileSync(fp, "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function loadProxyConfig() {
  const explicitConfigPath = process.env.RT_PROXY_CONFIG;
  const candidatePaths = [
    explicitConfigPath,
    path.join(app.getPath("userData"), "proxy.config.json"),
    path.join(__dirname, "proxy.config.local.json"),
  ].filter(Boolean);

  for (const fp of candidatePaths) {
    const parsed = readJsonIfExists(fp);
    if (parsed) return parsed;
  }
  return null;
}

async function configureProxy(sess) {
  const cfg = loadProxyConfig();
  if (!cfg?.enabled) return;

  const protocol = String(cfg.protocol || "http").toLowerCase();
  const host = String(cfg.host || "").trim();
  const port = Number(cfg.port);
  if (!host || !Number.isFinite(port) || port <= 0) return;

  const proxyRules = `${protocol}://${host}:${port}`;
  const proxyBypassRules =
    Array.isArray(cfg.bypass) && cfg.bypass.length > 0
      ? cfg.bypass.map((x) => String(x).trim()).filter(Boolean).join(";")
      : "<local>";

  await sess.setProxy({
    proxyRules,
    proxyBypassRules,
  });

  const username = String(cfg.username || "").trim();
  const password = String(cfg.password || "");
  proxyAuth = username
    ? {
        username,
        password,
      }
    : null;
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
    console.error("Failed to configure proxy:", e?.message || e);
  }

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
