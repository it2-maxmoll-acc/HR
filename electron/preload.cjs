"use strict";

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("api", {
  listDesktopSources: () => ipcRenderer.invoke("list-desktop-sources"),
  saveTranscript: (payload) => ipcRenderer.invoke("save-transcript", payload),
  autosaveTranscript: (payload) => ipcRenderer.invoke("autosave-transcript", payload),
  autosaveToSession: (payload) => ipcRenderer.invoke("autosave-to-session", payload),
  getAppInfo: () => ipcRenderer.invoke("get-app-info"),

  // Session history
  listSessions: () => ipcRenderer.invoke("list-sessions"),
  deleteSession: (filename) => ipcRenderer.invoke("delete-session", filename),
  loadSession: (filename) => ipcRenderer.invoke("load-session", filename),

  // Secure API key storage (uses OS keychain via Electron safeStorage)
  storeApiKey: (key) => ipcRenderer.invoke("store-api-key", key),
  loadApiKey: () => ipcRenderer.invoke("load-api-key"),

  // Overlay window
  openOverlay: () => ipcRenderer.invoke("open-overlay"),
  pushTranscriptLine: (msg) => ipcRenderer.invoke("push-transcript-line", msg),
  clearLines: () => ipcRenderer.invoke("clear-lines"),
  pushRecordingState: (state) => ipcRenderer.invoke("push-recording-state", state),
  recordingControl: (action) => ipcRenderer.invoke("recording-control", action),

  // Overlay renderer listeners (used inside overlay.js)
  onNewLine: (cb) => {
    ipcRenderer.removeAllListeners("new-line");
    ipcRenderer.on("new-line", (_e, msg) => cb(msg));
  },
  onClearLines: (cb) => {
    ipcRenderer.removeAllListeners("clear-lines");
    ipcRenderer.on("clear-lines", () => cb());
  },
  onRecordingState: (cb) => {
    ipcRenderer.removeAllListeners("recording-state");
    ipcRenderer.on("recording-state", (_e, state) => cb(state));
  },

  // Main window listener: receives actions from overlay buttons
  onRecordingControl: (cb) => {
    ipcRenderer.removeAllListeners("recording-control");
    ipcRenderer.on("recording-control", (_e, action) => cb(action));
  },
});
