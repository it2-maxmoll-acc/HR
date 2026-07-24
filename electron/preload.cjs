"use strict";

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("api", {
  listDesktopSources: () => ipcRenderer.invoke("list-desktop-sources"),
  saveTranscript: (payload) => ipcRenderer.invoke("save-transcript", payload),
  autosaveTranscript: (payload) => ipcRenderer.invoke("autosave-transcript", payload),
  getAppInfo: () => ipcRenderer.invoke("get-app-info"),

  // Overlay window
  openOverlay: () => ipcRenderer.invoke("open-overlay"),
  pushTranscriptLine: (msg) => ipcRenderer.invoke("push-transcript-line", msg),
  clearLines: () => ipcRenderer.invoke("clear-lines"),

  // Overlay renderer listeners (used inside overlay.js)
  onNewLine: (cb) => {
    ipcRenderer.removeAllListeners("new-line");
    ipcRenderer.on("new-line", (_e, msg) => cb(msg));
  },
  onClearLines: (cb) => {
    ipcRenderer.removeAllListeners("clear-lines");
    ipcRenderer.on("clear-lines", () => cb());
  },
});
