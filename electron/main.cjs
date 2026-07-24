"use strict";

const { app, BrowserWindow, ipcMain, dialog, session } = require("electron");
const path = require("path");
const fs = require("fs");
const os = require("os");

const isDev = !app.isPackaged;

let overlayWin = null;

function createWindow() {
  const win = new BrowserWindow({
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

  win.loadFile(path.join(__dirname, "renderer", "index.html"));

  // Close overlay when the main window closes.
  win.on("closed", () => {
    if (overlayWin && !overlayWin.isDestroyed()) overlayWin.close();
  });

  if (isDev) {
    win.webContents.openDevTools({ mode: "detach" });
  }
}

app.whenReady().then(() => {
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

  const win = BrowserWindow.getFocusedWindow();
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

ipcMain.handle("get-app-info", () => ({
  version: app.getVersion(),
  platform: process.platform,
  homedir: os.homedir(),
}));

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
