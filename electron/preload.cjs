"use strict";

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("api", {
  listDesktopSources: () => ipcRenderer.invoke("list-desktop-sources"),
  saveTranscript: (payload) => ipcRenderer.invoke("save-transcript", payload),
  autosaveTranscript: (payload) =>
    ipcRenderer.invoke("autosave-transcript", payload),
  getAppInfo: () => ipcRenderer.invoke("get-app-info"),
});