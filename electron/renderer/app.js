// Realtime Transcriber — renderer

const CHUNK_MS = 4000; // window length — longer chunks give the model a full phrase
const OVERLAP_MS = 500; // overlap between chunks so words aren't cut
const SAMPLE_RATE = 16000;
// Allow several delayed chunks or network jitter before starting a new phrase line.
const MERGE_TOLERANCE_MS = 5000;
// Merge window total: CHUNK_MS + MERGE_TOLERANCE_MS.
const MERGE_GAP_MS = CHUNK_MS + MERGE_TOLERANCE_MS;
// Detect and remove up to this many repeated boundary words from overlap.
const MAX_OVERLAP_WORDS = 8;
const MIN_APPEND_OVERLAP_WORDS = 2;
const CROSS_ROLE_DUP_WINDOW_MS = 8000;
const CROSS_ROLE_DUP_MIN_CHARS = 16;
const CROSS_ROLE_DUP_MIN_WORDS = 3;
const CROSS_ROLE_PROMOTION_RATIO = 1.35;
const SAME_ROLE_DUP_WINDOW_MS = 45000;
const SAME_ROLE_ECHO_WINDOW_MS = 12000;
const SAME_ROLE_WEAKER_RATIO = 0.9;
const SENSITIVITY_MIN_LEVEL = 1;
const SENSITIVITY_MAX_LEVEL = 10;
const DEFAULT_SENSITIVITY_LEVEL = 6;

const els = {
  status: document.getElementById("status"),
  timer: document.getElementById("timer"),
  mic: document.getElementById("mic-select"),
  sys: document.getElementById("sys-select"),
  apiKey: document.getElementById("api-key"),
  apiKeyRow: document.getElementById("api-key-row"),
  modelSelect: document.getElementById("model-select"),
  start: document.getElementById("start"),
  stop: document.getElementById("stop"),
  pause: document.getElementById("pause"),
  save: document.getElementById("save"),
  download: document.getElementById("download"),
  banner: document.getElementById("banner"),
  log: document.getElementById("log"),
  hrSensitivity: document.getElementById("hr-sensitivity"),
  hrSensValue: document.getElementById("hr-sens-value"),
  candidateSensitivity: document.getElementById("candidate-sensitivity"),
  candidateSensValue: document.getElementById("candidate-sens-value"),
  overlay: document.getElementById("overlay"),
  history: document.getElementById("history"),
  historyPanel: document.getElementById("history-panel"),
  historyList: document.getElementById("history-list"),
  historyClose: document.getElementById("history-close"),
  historyViewer: document.getElementById("history-viewer"),
  historyViewerTitle: document.getElementById("history-viewer-title"),
  historyViewerMeta: document.getElementById("history-viewer-meta"),
  historyViewerContent: document.getElementById("history-viewer-content"),
  historyViewerClose: document.getElementById("history-viewer-close"),
  historyViewerSave: document.getElementById("history-viewer-save"),
  historyViewerComment: document.getElementById("history-viewer-comment"),
  historyMultiselectBar: document.getElementById("history-multiselect-bar"),
  historySelectedCount: document.getElementById("history-selected-count"),
  historyDeleteSelected: document.getElementById("history-delete-selected"),
  renameModal: document.getElementById("rename-modal"),
  renameInput: document.getElementById("rename-input"),
  renameCancel: document.getElementById("rename-cancel"),
  renameConfirm: document.getElementById("rename-confirm"),
  logsBtn: document.getElementById("logs-btn"),
  logsPanel: document.getElementById("logs-panel"),
  logsList: document.getElementById("logs-list"),
  logsClose: document.getElementById("logs-close"),
  logsCopy: document.getElementById("logs-copy"),
  logsClear: document.getElementById("logs-clear"),
  proxyRow: document.getElementById("proxy-row"),
  proxyEnabled: document.getElementById("proxy-enabled"),
  proxyStatusText: document.getElementById("proxy-status-text"),
  proxyAutoFallback: document.getElementById("proxy-auto-fallback"),
  proxyAutoFallbackRow: document.getElementById("proxy-auto-fallback-row"),
  micTest: document.getElementById("mic-test"),
  micMeterWrap: document.getElementById("mic-meter-wrap"),
  micMeterBar: document.getElementById("mic-meter-bar"),
  micMeterLabel: document.getElementById("mic-meter-label"),
};

const state = {
  recording: false,
  paused: false,
  startedAt: 0,
  timerInterval: null,
  captures: [], // { role, stream, audioCtx, source, processor, buffer, chunkIndex }
  messages: [], // { role, tsMs, lastTsMs, text, id }
  nextId: 1,
  historyTab: "all", // "all" | "favorites"
  prevText: {}, // { [role]: last ~100 chars of transcribed text for context prompt }
};

// Current session file for autosave (set on start, cleared on stop).
let _currentSessionFile = null;
let _autosaveInterval = null;

// -------- init --------

// Load API key from openai.config.json (config file) or fall back to
// the legacy safeStorage key so existing users are not broken.
let _openaiApiKey = "";
let _openaiConfigPath = "";
(async () => {
  try {
    const cfg = await window.api.loadOpenAIConfig?.();
    if (cfg?.apiKey) {
      _openaiApiKey = cfg.apiKey.trim();
      _openaiConfigPath = cfg.configPath || "";
      // Mirror into the legacy UI field so users can still see/edit it there
      // while the field is visible (fallback for power users).
      if (els.apiKey) els.apiKey.value = _openaiApiKey;
    } else {
      // Fall back to old safeStorage key (migration path).
      const legacy = await window.api.loadApiKey?.();
      if (legacy) {
        _openaiApiKey = legacy.trim();
        if (els.apiKey) els.apiKey.value = _openaiApiKey;
      }
    }
  } catch (e) {
    console.warn("[apikey] Failed to load OpenAI config:", e);
    // Last-resort: try legacy safeStorage
    const legacy = await window.api.loadApiKey?.().catch(() => "");
    if (legacy) {
      _openaiApiKey = legacy.trim();
      if (els.apiKey) els.apiKey.value = _openaiApiKey;
    }
  }
})();

// Keep in-memory key in sync when user edits the field (legacy/fallback UI).
if (els.apiKey) {
  els.apiKey.addEventListener("change", () => {
    _openaiApiKey = els.apiKey.value.trim();
    window.api.storeApiKey?.(_openaiApiKey);
    window.api.saveOpenAIConfig?.({ apiKey: _openaiApiKey });
  });
}

const savedModel = localStorage.getItem("openai-model") || "gpt-4o-transcribe";
els.modelSelect.value = savedModel;
els.modelSelect.addEventListener("change", () =>
  localStorage.setItem("openai-model", els.modelSelect.value),
);

// Sensitivity 1..10 → thresholds. Higher = stricter (drops more as silence/noise).
// The upper end is intentionally stricter than the old 1..5 scale so noisy
// microphones and loopback audio can be filtered more aggressively.
const SENSITIVITY_PROFILE_MIN = { rms: 0.004, peak: 0.018, voiced: 0.015, voiceFloor: 0.02 };
const SENSITIVITY_PROFILE_MAX = { rms: 0.045, peak: 0.15, voiced: 0.22, voiceFloor: 0.045 };
const ROLE_SENSITIVITY_SETTINGS = {
  HR: {
    input: els.hrSensitivity,
    value: els.hrSensValue,
    storageKey: "sensitivity-hr",
  },
  Кандидат: {
    input: els.candidateSensitivity,
    value: els.candidateSensValue,
    storageKey: "sensitivity-candidate",
  },
};
const roleSilenceProfiles = {};

const legacySensitivityLevel = mapLegacySensitivityLevel(
  Number(localStorage.getItem("sensitivity")),
);
for (const [role, config] of Object.entries(ROLE_SENSITIVITY_SETTINGS)) {
  const level = loadStoredSensitivityLevel(config, legacySensitivityLevel);
  applySensitivityLevel(role, level);
  config.input.addEventListener("input", () => {
    applySensitivityLevel(role, Number(config.input.value));
  });
}

async function refreshDevices() {
  try {
    // getUserMedia once to unlock device labels.
    const probe = await navigator.mediaDevices.getUserMedia({ audio: true }).catch(() => null);
    const devices = await navigator.mediaDevices.enumerateDevices();
    const mics = devices.filter((d) => d.kind === "audioinput");
    const savedMic = localStorage.getItem("mic-source");
    els.mic.innerHTML = "";
    for (const m of mics) {
      const opt = document.createElement("option");
      opt.value = m.deviceId;
      opt.textContent = m.label || `Микрофон ${m.deviceId.slice(0, 6)}`;
      els.mic.appendChild(opt);
    }
    if (savedMic && mics.some((m) => m.deviceId === savedMic)) {
      els.mic.value = savedMic;
    }
    // Candidate audio should come from Windows loopback or an explicit virtual
    // loopback device. Offering every physical microphone here makes it easy to
    // accidentally record HR twice under both roles.
    els.sys.innerHTML = "";
    const loop = document.createElement("option");
    loop.value = "loopback";
    loop.textContent = "Звук из Windows (loopback, всё что воспроизводит ПК)";
    els.sys.appendChild(loop);
    const loopbackInputs = mics.filter((m) => isLikelyLoopbackInput(m));
    for (const m of loopbackInputs) {
      const opt = document.createElement("option");
      opt.value = "input:" + m.deviceId;
      opt.textContent =
        "Виртуальный loopback: " + (m.label || `устройство ${m.deviceId.slice(0, 6)}`);
      els.sys.appendChild(opt);
    }
    const savedSys = localStorage.getItem("sys-source");
    const sysChoices = new Set(["loopback", ...loopbackInputs.map((m) => `input:${m.deviceId}`)]);
    if (savedSys && sysChoices.has(savedSys)) {
      els.sys.value = savedSys;
    } else if (savedSys && savedSys !== "loopback") {
      console.warn(
        `[audio] Ignored saved candidate source "${savedSys}" because it is not a loopback/system-audio device.`,
      );
      localStorage.setItem("sys-source", "loopback");
    }
    if (probe) probe.getTracks().forEach((t) => t.stop());

    // On Windows, connecting AirPods (or any Bluetooth HFP headset) can hide
    // the built-in laptop microphone — all enumerated mics appear as Bluetooth
    // variants. Warn the user so they know to disconnect the headset first or
    // use it specifically as a recording device.
    const labeledMics = mics.filter((m) => m.label);
    if (labeledMics.length > 0 && labeledMics.every((m) => isBluetoothMic(m))) {
      showBanner(
        "⚠️ Обнаружены только Bluetooth-микрофоны (возможно AirPods). " +
          "Встроенный микрофон ноутбука скрыт Windows. " +
          "Чтобы увидеть микрофон ноутбука, временно отключите Bluetooth-наушники — " +
          "или используйте текущий микрофон (запись будет работать, но звук в наушниках может пропасть).",
      );
    }
  } catch (e) {
    showBanner("Не удалось получить список микрофонов: " + e.message);
  }
}

refreshDevices();
navigator.mediaDevices.addEventListener?.("devicechange", refreshDevices);
els.sys.addEventListener("change", () => localStorage.setItem("sys-source", els.sys.value));
els.mic.addEventListener("change", () => localStorage.setItem("mic-source", els.mic.value));

// -------- controls --------

els.start.addEventListener("click", () => start().catch(handleFatal));
els.stop.addEventListener("click", () => stop().catch(handleFatal));
els.pause.addEventListener("click", togglePause);
els.save.addEventListener("click", () => saveTranscript(false));
els.download.addEventListener("click", () => saveTranscript(false));
els.overlay.addEventListener("click", () => window.api.openOverlay?.());
els.history.addEventListener("click", openHistoryPanel);
els.historyClose.addEventListener("click", closeHistoryPanel);
els.historyViewerClose.addEventListener("click", () => els.historyViewer.classList.add("hidden"));
els.historyViewerSave.addEventListener("click", saveViewerSession);
els.historyDeleteSelected.addEventListener("click", deleteSelectedSessions);

// History tabs
document.getElementById("history-panel").addEventListener("click", (e) => {
  const tab = e.target.closest(".history-tab");
  if (!tab) return;
  const tabName = tab.dataset.tab;
  if (tabName === state.historyTab) return;
  state.historyTab = tabName;
  document
    .querySelectorAll(".history-tab")
    .forEach((t) => t.classList.toggle("active", t.dataset.tab === tabName));
  refreshHistoryList();
});

// Rename modal
els.renameCancel.addEventListener("click", closeRenameModal);
els.renameModal.addEventListener("click", (e) => {
  if (e.target === els.renameModal) closeRenameModal();
});
els.renameInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") els.renameConfirm.click();
  if (e.key === "Escape") closeRenameModal();
});
els.logsBtn.addEventListener("click", openLogsPanel);
els.logsClose.addEventListener("click", closeLogsPanel);
els.logsClear.addEventListener("click", clearLogs);
els.logsCopy.addEventListener("click", copyLogs);

// -------- mic test --------

let _micTestStream = null;
let _micTestCtx = null;
let _micTestAnalyser = null;
let _micTestRaf = null;
let _micTestActive = false;

async function startMicTest() {
  const deviceId = els.mic.value;
  try {
    _micTestStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: deviceId ? { exact: deviceId } : undefined,
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      },
    });
  } catch (e) {
    showBanner("Не удалось открыть микрофон: " + e.message);
    return;
  }
  _micTestCtx = new (window.AudioContext || window.webkitAudioContext)();
  const source = _micTestCtx.createMediaStreamSource(_micTestStream);
  _micTestAnalyser = _micTestCtx.createAnalyser();
  _micTestAnalyser.fftSize = 256;
  source.connect(_micTestAnalyser);
  // Do NOT connect to destination — no playback.

  els.micMeterWrap.classList.remove("hidden");
  els.micTest.textContent = "⏹ Стоп";
  _micTestActive = true;

  const data = new Uint8Array(_micTestAnalyser.frequencyBinCount);
  function tick() {
    if (!_micTestActive) return;
    _micTestRaf = requestAnimationFrame(tick);
    _micTestAnalyser.getByteFrequencyData(data);
    let sum = 0;
    for (let i = 0; i < data.length; i++) sum += data[i];
    const avg = sum / data.length;
    const pct = Math.min(100, Math.round((avg / 255) * 100 * 3));
    els.micMeterBar.style.width = pct + "%";
    els.micMeterBar.style.background = pct > 70 ? "#ff6b6b" : pct > 30 ? "#f0a500" : "#4c8bf5";
    els.micMeterLabel.textContent = pct + "%";
  }
  tick();
}

function stopMicTest() {
  _micTestActive = false;
  if (_micTestRaf) {
    cancelAnimationFrame(_micTestRaf);
    _micTestRaf = null;
  }
  if (_micTestStream) {
    _micTestStream.getTracks().forEach((t) => t.stop());
    _micTestStream = null;
  }
  if (_micTestCtx) {
    _micTestCtx.close().catch(() => {});
    _micTestCtx = null;
  }
  _micTestAnalyser = null;
  els.micMeterWrap.classList.add("hidden");
  els.micMeterBar.style.width = "0%";
  els.micMeterLabel.textContent = "0%";
  els.micTest.textContent = "🎙 Тест";
}

els.micTest.addEventListener("click", () => {
  if (_micTestActive) {
    stopMicTest();
  } else {
    startMicTest();
  }
});

// Stop mic test when recording starts.
// (handled inline in start() body via stopMicTest call)

// -------- logging system --------

const _logs = [];

(function patchConsole() {
  const levels = { log: "info", info: "info", warn: "warn", error: "error", debug: "debug" };
  for (const [method, level] of Object.entries(levels)) {
    const orig = console[method].bind(console);
    console[method] = (...args) => {
      orig(...args);
      const msg = args
        .map((a) => {
          if (a instanceof Error) return a.stack || String(a);
          if (typeof a === "object") {
            try {
              return JSON.stringify(a, null, 2);
            } catch {
              return String(a);
            }
          }
          return String(a);
        })
        .join(" ");
      pushLog(level, msg);
    };
  }
})();

function pushLog(level, msg) {
  const entry = { level, msg, ts: new Date().toISOString().slice(11, 23) };
  _logs.push(entry);
  if (_logs.length > 500) _logs.shift();
  // If logs panel is open — append immediately.
  if (!els.logsPanel.classList.contains("hidden")) {
    appendLogRow(entry);
  }
}

function appendLogRow(entry) {
  const row = document.createElement("div");
  row.className = `log-entry log-entry-${entry.level}`;
  row.textContent = `[${entry.ts}] [${entry.level.toUpperCase()}] ${entry.msg}`;
  els.logsList.appendChild(row);
  els.logsList.scrollTop = els.logsList.scrollHeight;
}

function openLogsPanel() {
  els.historyPanel.classList.add("hidden");
  els.logsList.innerHTML = "";
  for (const entry of _logs) appendLogRow(entry);
  els.logsPanel.classList.remove("hidden");
}

function closeLogsPanel() {
  els.logsPanel.classList.add("hidden");
}

function clearLogs() {
  _logs.length = 0;
  els.logsList.innerHTML = "";
}

async function copyLogs() {
  const text = _logs.map((e) => `[${e.ts}] [${e.level.toUpperCase()}] ${e.msg}`).join("\n");
  const originalLabel = els.logsCopy.textContent;
  const showResult = (label, revertMs = 1500) => {
    els.logsCopy.textContent = label;
    setTimeout(() => {
      els.logsCopy.textContent = originalLabel;
    }, revertMs);
  };
  try {
    // Prefer the native Electron clipboard via IPC: unlike navigator.clipboard,
    // it is not gated by the renderer's permission request handler and works
    // reliably regardless of window focus or secure-context quirks.
    if (window.api?.copyToClipboard) {
      const result = await window.api.copyToClipboard(text);
      if (result?.success) {
        showResult("✅ Скопировано");
        return;
      }
    }
    await navigator.clipboard.writeText(text);
    showResult("✅ Скопировано");
  } catch (err) {
    console.error(`[logs] copy failed: ${err?.message || err}`);
    showResult("❌ Ошибка копирования");
  }
}

function logProxyDiagnostics(diag) {
  if (!diag) {
    console.warn("[proxy] diagnostics are unavailable");
    return;
  }
  const selected = diag.selectedPath || "<none>";
  const enabled = Boolean(diag.selectedConfig?.enabled);
  console.log(
    `[proxy] selected=${selected} enabled=${enabled} applyAttempted=${Boolean(diag.applyAttempted)} applySucceeded=${Boolean(diag.applySucceeded)} authConfigured=${Boolean(diag.authConfigured)} resolved=${diag.resolvedProxy || "<n/a>"}`,
  );
  if (diag.userDataConfigPath) {
    console.log(`[proxy] userDataConfigPath=${diag.userDataConfigPath}`);
  }
  if (diag.proxyRules) {
    console.log(
      `[proxy] protocol=${diag.protocol || "<n/a>"} proxyRules=${diag.proxyRules} proxyBypassRules=${diag.proxyBypassRules || "<n/a>"}`,
    );
  }
  if (diag.rawSocketTest) {
    const t = diag.rawSocketTest;
    console.log(
      `[proxy] rawSocketTest success=${Boolean(t.success)} durationMs=${t.durationMs} error=${t.error || "<none>"}`,
    );
  }
  if (diag.openAiProbe) {
    const t = diag.openAiProbe;
    console.log(
      `[proxy] openAiProbe success=${Boolean(t.success)} durationMs=${t.durationMs} detail=${t.detail || "<none>"}`,
    );
  }
  if (diag.directProbe) {
    const t = diag.directProbe;
    console.log(
      `[proxy] directProbe success=${Boolean(t.success)} durationMs=${t.durationMs} detail=${t.detail || "<none>"}`,
    );
  }
  if (diag.directFallbackApplied) {
    console.warn("[proxy] DIRECT fallback is active because proxy route probe failed.");
  }
  if (Array.isArray(diag.candidates)) {
    console.log("[proxy] candidates=", diag.candidates);
  }
  if (Array.isArray(diag.warnings)) {
    for (const warn of diag.warnings) {
      console.warn(`[proxy] ${warn}`);
    }
  }
  if (diag.error) {
    console.error(`[proxy] error: ${diag.error}`);
  }
}

window.api
  .getProxyDiagnostics?.()
  .then((diag) => {
    logProxyDiagnostics(diag);
    initProxyToggle(diag);
  })
  .catch((e) => {
    console.error("[proxy] failed to load diagnostics", e?.message || e);
  });

function initProxyToggle(diag) {
  if (!els.proxyEnabled || !els.proxyStatusText) return;

  // Show the row only when a proxy config with a non-empty host is present.
  const hasConfig = Boolean(diag?.selectedConfig?.host);

  if (!hasConfig) {
    if (els.proxyRow) els.proxyRow.style.display = "none";
    return;
  }

  // Initial state: use runtimeEnabled from diagnostics.
  const currentlyEnabled = Boolean(diag?.runtimeEnabled);
  els.proxyEnabled.checked = currentlyEnabled;
  setProxyStatusText(currentlyEnabled);

  // Auto (VPN) checkbox — show it whenever a config is present.
  if (els.proxyAutoFallback && els.proxyAutoFallbackRow) {
    els.proxyAutoFallbackRow.classList.remove("hidden");
    els.proxyAutoFallback.checked = Boolean(diag?.selectedConfig?.autoDirectFallback);

    els.proxyAutoFallback.addEventListener("change", async () => {
      const enable = els.proxyAutoFallback.checked;
      try {
        const result = await window.api.updateProxyConfig?.({ autoDirectFallback: enable });
        if (!result?.ok) {
          console.error("[proxy] updateProxyConfig failed:", result?.error);
          els.proxyAutoFallback.checked = !enable;
          return;
        }
        console.log(`[proxy] autoDirectFallback set to ${enable}`);
      } catch (e) {
        console.error("[proxy] updateProxyConfig error:", e?.message || e);
        els.proxyAutoFallback.checked = !enable;
      }
    });
  }

  els.proxyEnabled.addEventListener("change", async () => {
    const enable = els.proxyEnabled.checked;
    els.proxyEnabled.disabled = true;
    els.proxyStatusText.textContent = enable ? "включение…" : "отключение…";
    els.proxyStatusText.className = "proxy-status-text";

    try {
      const result = await window.api.toggleProxy(enable);
      if (!result.ok) {
        els.proxyEnabled.checked = !enable;
        setProxyStatusText(!enable);
        console.error("[proxy] toggle failed:", result.error);
        return;
      }
      setProxyStatusText(result.runtimeEnabled);
      console.log(`[proxy] toggled ${result.runtimeEnabled ? "ON" : "OFF"} by user`);
    } catch (e) {
      els.proxyEnabled.checked = !enable;
      setProxyStatusText(!enable);
      console.error("[proxy] toggle error:", e?.message || e);
    } finally {
      els.proxyEnabled.disabled = false;
    }
  });
}

function setProxyStatusText(enabled) {
  if (!els.proxyStatusText) return;
  if (enabled) {
    els.proxyStatusText.textContent = "включён";
    els.proxyStatusText.className = "proxy-status-text active";
  } else {
    els.proxyStatusText.textContent = "выключен";
    els.proxyStatusText.className = "proxy-status-text inactive";
  }
}

// Real Chromium net:: error codes for OpenAI requests (see main.cjs
// webRequest.onErrorOccurred) — surfaces the actual cause behind a generic
// fetch() "Failed to fetch" (e.g. net::ERR_TUNNEL_CONNECTION_FAILED,
// net::ERR_SSL_PROTOCOL_ERROR, net::ERR_CONNECTION_RESET/CLOSED).
// Also forwards proxy login-event diagnostics from the main process.
window.api.onNetError?.((msg) => {
  if (msg.startsWith("[proxy] login event:")) {
    console.log(msg);
  } else {
    console.error(msg);
  }
});

window.api.onRecordingControl?.((action) => {
  if (action === "start") start().catch(handleFatal);
  else if (action === "stop") stop().catch(handleFatal);
  else if (action === "pause") togglePause();
});

function handleFatal(e) {
  console.error(e);
  showBanner("Ошибка: " + (e?.message || e));
  stop().catch(() => {});
}

function showBanner(msg) {
  els.banner.textContent = msg;
  els.banner.classList.remove("hidden");
}
function hideBanner() {
  els.banner.classList.add("hidden");
}

function toggleDownload() {
  const hasContent = state.messages.some((m) => m.text.trim().length > 0);
  els.download.disabled = !hasContent;
}

// -------- recording lifecycle --------

async function start() {
  if (state.recording) return;
  hideBanner();
  // Stop mic test if running so it doesn't interfere with the recording stream.
  if (_micTestActive) stopMicTest();
  els.start.disabled = true;
  els.stop.disabled = false;
  els.pause.disabled = false;
  els.save.disabled = false;

  state.recording = true;
  state.paused = false;

  // Only reset messages/timer if not continuing from a loaded session.
  if (!_currentSessionFile) {
    state.startedAt = performance.now();
    state.messages = [];
    state.nextId = 1;
    els.log.innerHTML = "";
    window.api.clearLines?.();
    const stamp = formatSessionStamp(new Date());
    _currentSessionFile = `session_${stamp}.txt`;
  }
  toggleDownload();

  updateStatus(true);
  state.timerInterval = setInterval(tickTimer, 500);

  // Autosave every 5 minutes so nothing is lost if the PC shuts down.
  _autosaveInterval = setInterval(periodicAutosave, 5 * 60 * 1000);

  window.api.pushRecordingState?.({ recording: true, paused: false });

  // Mic
  const micDeviceId = els.mic.value;
  const micLabel = els.mic.selectedOptions[0]?.textContent || micDeviceId || "default";
  const sysChoice = els.sys.value || "loopback";
  const sysLabel = els.sys.selectedOptions[0]?.textContent || sysChoice;
  console.log(`[audio] start capture hrMic="${micLabel}" candidateSource="${sysLabel}"`);
  const micStream = await navigator.mediaDevices.getUserMedia({
    audio: {
      deviceId: micDeviceId ? { exact: micDeviceId } : undefined,
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: false,
    },
  });

  // System audio via getDisplayMedia (Electron 30+ with setDisplayMediaRequestHandler)
  let sysStream = null;
  try {
    if (sysChoice.startsWith("input:")) {
      const deviceId = sysChoice.slice("input:".length);
      sysStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          deviceId: { exact: deviceId },
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        },
      });
    } else {
      sysStream = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: true,
      });
      // Drop video tracks — we only need audio.
      sysStream.getVideoTracks().forEach((t) => t.stop());
    }
  } catch (e) {
    console.warn("getDisplayMedia failed, falling back to desktopCapturer", e);
    try {
      const sources = await window.api.listDesktopSources();
      const screen = sources.find((s) => s.id.startsWith("screen:")) || sources[0];
      if (screen) {
        sysStream = await navigator.mediaDevices.getUserMedia({
          audio: {
            mandatory: {
              chromeMediaSource: "desktop",
              chromeMediaSourceId: screen.id,
            },
          },
          video: {
            mandatory: {
              chromeMediaSource: "desktop",
              chromeMediaSourceId: screen.id,
            },
          },
        });
        sysStream.getVideoTracks().forEach((t) => t.stop());
      }
    } catch (e2) {
      showBanner(
        "Не удалось захватить системный звук. Только речь HR будет расшифрована. Причина: " +
          e2.message,
      );
    }
  }

  await startCapture("HR", micStream);
  if (sysStream && sysStream.getAudioTracks().length > 0) {
    await startCapture("Кандидат", sysStream);
  }
}

async function stop() {
  if (!state.recording) return;
  state.recording = false;
  state.paused = false;
  updateStatus(false);

  clearInterval(state.timerInterval);
  state.timerInterval = null;
  clearInterval(_autosaveInterval);
  _autosaveInterval = null;

  // Flush and tear down each capture.
  for (const cap of state.captures) {
    try {
      // Send remaining buffer as a final chunk.
      if (cap.buffer.length > 0) {
        const audio = flushBuffer(cap);
        if (!isSilent(cap.role, audio.stats)) {
          sendChunk(cap.role, audio.wav, cap.startTs, cap.chunkIndex++, audio.stats.rms);
        }
      }
      cap.processor.disconnect();
      cap.source.disconnect();
      await cap.audioCtx.close();
      cap.stream.getTracks().forEach((t) => t.stop());
    } catch (e) {
      console.warn("teardown", e);
    }
  }
  state.captures = [];
  state.prevText = {};

  els.start.disabled = false;
  els.stop.disabled = true;
  els.pause.disabled = true;
  els.pause.textContent = "⏸ Пауза";

  window.api.pushRecordingState?.({ recording: false, paused: false });

  // Save to current session file and clear it.
  try {
    const content = buildTranscriptText();
    if (content.trim() && _currentSessionFile) {
      await window.api.autosaveToSession({ filename: _currentSessionFile, content });
    }
  } catch (e) {
    console.warn("autosave on stop", e);
  }
  _currentSessionFile = null;
}

function updateStatus(recording) {
  els.status.textContent = recording
    ? state.paused
      ? "⏸ Пауза"
      : "● Идёт запись"
    : "Готов к записи";
  els.status.classList.toggle("recording", recording && !state.paused);
}

function togglePause() {
  if (!state.recording) return;
  state.paused = !state.paused;
  els.pause.textContent = state.paused ? "▶ Продолжить" : "⏸ Пауза";
  updateStatus(true);
  window.api.pushRecordingState?.({ recording: true, paused: state.paused });
}

async function periodicAutosave() {
  if (!_currentSessionFile) return;
  const content = buildTranscriptText();
  if (!content.trim()) return;
  try {
    await window.api.autosaveToSession({ filename: _currentSessionFile, content });
  } catch (e) {
    console.warn("periodic autosave", e);
  }
}

function tickTimer() {
  const s = Math.floor((performance.now() - state.startedAt) / 1000);
  const m = Math.floor(s / 60);
  els.timer.textContent = String(m).padStart(2, "0") + ":" + String(s % 60).padStart(2, "0");
}

// -------- audio capture with ScriptProcessor (portable) --------

async function startCapture(role, stream) {
  const audioCtx = new (window.AudioContext || window.webkitAudioContext)({
    sampleRate: SAMPLE_RATE,
  });
  const source = audioCtx.createMediaStreamSource(stream);
  const processor = audioCtx.createScriptProcessor(4096, 1, 1);

  const cap = {
    role,
    stream,
    audioCtx,
    source,
    processor,
    processingSink: null,
    buffer: [],
    bufferSamples: 0,
    chunkIndex: 0,
    startTs: performance.now() - state.startedAt,
    windowStartTs: performance.now() - state.startedAt,
  };

  const chunkSamples = Math.round((audioCtx.sampleRate * CHUNK_MS) / 1000);
  const overlapSamples = Math.round((audioCtx.sampleRate * OVERLAP_MS) / 1000);

  processor.onaudioprocess = (e) => {
    if (!state.recording || state.paused) return;
    const input = e.inputBuffer.getChannelData(0);
    // Copy — the buffer is reused by the API.
    cap.buffer.push(new Float32Array(input));
    cap.bufferSamples += input.length;

    if (cap.bufferSamples >= chunkSamples) {
      const merged = mergeFloat32(cap.buffer, cap.bufferSamples);
      const chunk = merged.subarray(0, chunkSamples);
      const profile = getSilenceProfile(cap.role);
      const stats = analyzeSamples(chunk, profile);

      const tsAtStart = cap.windowStartTs;
      const idx = cap.chunkIndex++;

      // Silence gate: skip near-silent chunks so the model doesn't hallucinate.
      if (!isSilent(cap.role, stats, profile)) {
        const wav = encodeWav(chunk, audioCtx.sampleRate);
        sendChunk(cap.role, wav, tsAtStart, idx, stats.rms);
      }

      // Keep overlap tail as head of next buffer.
      const tail = merged.subarray(chunkSamples - overlapSamples);
      cap.buffer = [new Float32Array(tail)];
      cap.bufferSamples = tail.length;
      cap.windowStartTs += ((chunkSamples - overlapSamples) * 1000) / audioCtx.sampleRate;
    }
  };

  // Route into a MediaStreamDestination instead of the real output device so
  // onaudioprocess keeps firing without opening or reconfiguring the user's
  // speakers/headphones. Some Windows drivers can briefly steal/mute playback
  // when a live AudioContext is connected to audioCtx.destination.
  const processingSink = audioCtx.createMediaStreamDestination();
  source.connect(processor);
  processor.connect(processingSink);
  cap.processingSink = processingSink;

  state.captures.push(cap);
}

function flushBuffer(cap) {
  const merged = mergeFloat32(cap.buffer, cap.bufferSamples);
  cap.buffer = [];
  cap.bufferSamples = 0;
  cap.startTs = cap.windowStartTs;
  const stats = analyzeSamples(merged, getSilenceProfile(cap.role));
  return {
    wav: encodeWav(merged, cap.audioCtx.sampleRate),
    stats,
  };
}

// Return true if the chunk is quiet enough that we treat it as silence.
// Uses RMS + peak + "voiced ratio" (share of samples above a small floor).
// All three metrics must be below their thresholds simultaneously to treat
// the chunk as silence. Using OR caused weak microphones (e.g. headsets) to
// drop valid speech when just one metric dipped slightly below the limit.
function isSilent(role, stats, profile = getSilenceProfile(role)) {
  if (stats.isSilent) {
    console.log(
      `[silence] role=${role} DROPPED chunk — rms=${stats.rms.toFixed(4)} (thr=${profile.rms.toFixed(4)})` +
        ` peak=${stats.peak.toFixed(4)} (thr=${profile.peak.toFixed(4)})` +
        ` voiced=${stats.voicedRatio.toFixed(3)} (thr=${profile.voiced.toFixed(3)})` +
        ` floor=${profile.voiceFloor.toFixed(3)}`,
    );
  }
  return stats.isSilent;
}

function analyzeSamples(samples, profile) {
  let sumSq = 0;
  let peak = 0;
  let voiced = 0;
  const voiceFloor = profile.voiceFloor;
  for (let i = 0; i < samples.length; i++) {
    const v = samples[i];
    sumSq += v * v;
    const a = v < 0 ? -v : v;
    if (a > peak) peak = a;
    if (a > voiceFloor) voiced++;
  }
  const rms = Math.sqrt(sumSq / samples.length);
  const voicedRatio = voiced / samples.length;
  // All three conditions must hold to consider the chunk silent.
  // Previously used OR which incorrectly dropped speech from weak microphones.
  const isQuiet = rms < profile.rms && peak < profile.peak && voicedRatio < profile.voiced;
  return { rms, peak, voicedRatio, isSilent: isQuiet };
}

// Short outputs the model tends to hallucinate on silence / room noise.
const HALLUCINATION_PHRASES = new Set([
  "hi",
  "hello",
  "hey",
  "ok",
  "okay",
  "yeah",
  "yes",
  "no",
  "thanks",
  "thank you",
  "okey",
  "bye",
  "meow",
  "uh",
  "um",
  "hmm",
  "mm",
  "mhm",
  "oh",
  "wow",
  "you",
  "the",
  "so",
  "well",
  "right",
  "привет",
  "да",
  "нет",
  "ага",
  "угу",
  "окей",
  "ок",
  "эм",
  "мм",
  "спасибо",
  "пока",
  "ой",
  "ну",
]);

// Fragments of the prompt that the model sometimes echoes back verbatim.
const PROMPT_FRAGMENTS = [
  "разговорная речь на русском",
  "транскрибируй дословно",
  "без добавлений и повторений",
  "не заканчивай незавершённые мысли",
  "числа пиши цифрами",
  "не используй многоточие",
];

function isLikelyHallucination(text) {
  const normalized = text
    .toLowerCase()
    .replace(/\.{2,}/g, "") // strip ellipsis sequences before other checks
    .replace(/[.!?,\s]+$/g, "")
    .replace(/^[.!?,\s]+/g, "")
    .trim();
  if (!normalized) return true;
  if (HALLUCINATION_PHRASES.has(normalized)) return true;
  // Very short outputs (<= 3 letters) are almost always noise.
  const lettersOnly = normalized.replace(/[^\p{L}]/gu, "");
  if (lettersOnly.length <= 3) return true;
  // Reject Whisper prompt echo: model sometimes repeats the prompt on silence.
  if (PROMPT_FRAGMENTS.some((frag) => normalized.includes(frag))) return true;
  return false;
}

// Accept only transcripts that contain enough Cyrillic characters (Russian).
// This blocks Turkish, Arabic, Korean, and other languages that the model
// can hallucinate when processing noise or silence.
function hasEnoughCyrillic(text) {
  if (!text) return false;
  const letters = text.match(/\p{L}/gu) || [];
  if (letters.length === 0) return false;
  let cyrillic = 0;
  for (const ch of letters) {
    if (/[\u0400-\u04FF]/.test(ch)) cyrillic++;
  }
  // Require at least 40% Cyrillic so Russian sentences with occasional
  // English proper nouns pass, while purely foreign-language outputs are dropped.
  return cyrillic / letters.length >= 0.4;
}

function mergeFloat32(chunks, totalLen) {
  const out = new Float32Array(totalLen);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

function encodeWav(samples, sampleRate) {
  // 16-bit PCM mono
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  writeStr(view, 0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  writeStr(view, 8, "WAVE");
  writeStr(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeStr(view, 36, "data");
  view.setUint32(40, samples.length * 2, true);
  let offset = 44;
  for (let i = 0; i < samples.length; i++, offset += 2) {
    let s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Blob([buffer], { type: "audio/wav" });
}

function writeStr(view, offset, str) {
  for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
}

function _sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// -------- send + render --------

async function sendChunk(role, wavBlob, tsMs, chunkIndex, audioLevel = 0) {
  const model = els.modelSelect.value || "whisper-1";
  const apiKey = (_openaiApiKey || (els.apiKey?.value || "")).trim();
  if (!apiKey) {
    showBanner(
      _openaiConfigPath
        ? `Добавьте OpenAI API Key в файл: ${_openaiConfigPath}`
        : "Введите OpenAI API Key в поле выше, затем начните запись снова.",
    );
    return;
  }

  const endpoint = "https://api.openai.com/v1/audio/transcriptions";
  const headers = { Authorization: "Bearer " + apiKey };

  // Retry indefinitely on 429 (rate limit) so nothing is ever dropped.
  // Each loop iteration checks state.recording so the loop exits cleanly when
  // the user stops recording while a retry is pending.
  // FormData is rebuilt on every attempt because the body stream is consumed
  // by the first fetch call — reusing the same object sends an empty body.
  let attempt = 0;
  while (true) {
    if (!state.recording) return;

    const form = new FormData();
    form.append("file", wavBlob, `chunk_${chunkIndex}.wav`);
    form.append("model", model);
    form.append("language", "ru");
    // Base instruction prompt — describes the recording situation so the model
    // transcribes verbatim without hallucinating completions or repeating words.
    const basePrompt =
      "Это разговорная речь на русском языке. Транскрибируй дословно, без добавлений и повторений. Не заканчивай незавершённые мысли. Числа пиши цифрами. Не используй многоточие. Если речь неразборчива, слышен только шум, фоновые голоса или нет явной русской фразы — ничего не добавляй. Лучше пропусти сомнительный фрагмент, чем придумай слова.";
    // Append the tail of the previous chunk so the model understands context
    // and doesn't capitalise mid-sentence or duplicate boundary words.
    const prev = (state.prevText[role] || "").slice(-120);
    const prompt = prev ? `${basePrompt} Предыдущий фрагмент: «${prev}»` : basePrompt;
    form.append("prompt", prompt);

    let res, data;
    try {
      res = await fetch(endpoint, {
        method: "POST",
        headers,
        body: form,
      });
      data = await res.json().catch(() => ({}));
    } catch (e) {
      // Network error — retry after a short pause (e.g. Wi-Fi blip).
      attempt++;
      const delay = Math.min(Math.pow(2, attempt) * 500, 8000);
      const errDetail = e instanceof Error ? e.message : String(e);
      console.error(`[sendChunk] network error attempt=${attempt}: ${errDetail}`);
      showBanner(`Сеть недоступна, повтор через ${delay / 1000}с… (попытка ${attempt})`);
      await _sleep(delay);
      continue;
    }

    if (res.status === 429) {
      // Rate-limited — back off and retry without ever dropping the chunk.
      attempt++;
      const delay = Math.min(Math.pow(2, attempt) * 500, 16000);
      console.warn(`[sendChunk] 429 rate-limited attempt=${attempt}`);
      showBanner(`Лимит OpenAI, повтор через ${delay / 1000}с… (попытка ${attempt})`);
      await _sleep(delay);
      continue;
    }

    if (res.status === 401) {
      console.error(`[sendChunk] 401 unauthorized`);
      showBanner("Неверный OpenAI API Key. Проверьте ключ и перезапустите запись.");
      return;
    }

    if (!res.ok) {
      const rawErr = data?.error;
      const errMsg =
        (rawErr && typeof rawErr === "object" ? rawErr.message : rawErr) || `HTTP ${res.status}`;
      console.error(
        `[sendChunk] error status=${res.status} msg="${errMsg}" data=${JSON.stringify(data)}`,
      );
      // Transient server error — retry a few times before giving up.
      if (res.status >= 500 && attempt < 5) {
        attempt++;
        const delay = Math.min(Math.pow(2, attempt) * 500, 8000);
        showBanner(`Ошибка сервера OpenAI (${res.status}), повтор через ${delay / 1000}с…`);
        await _sleep(delay);
        continue;
      }
      addMessage(role, tsMs, `[ошибка: ${errMsg}]`, chunkIndex, audioLevel);
      return;
    }

    // Success — clear any lingering error banner.
    hideBanner();
    console.log(`[sendChunk] ok role=${role} chunkIndex=${chunkIndex}`);
    const rawText = (data.text || "").trim();
    // Strip excessive ellipsis sequences the model sometimes produces.
    const text = rawText
      .replace(/\.{2,}/g, "")
      .replace(/\s{2,}/g, " ")
      .trim();
    if (text && !isLikelyHallucination(rawText) && hasEnoughCyrillic(text)) {
      // Remember tail for next chunk's context prompt.
      state.prevText[role] = text;
      addOrMergeMessage(role, tsMs, text, chunkIndex, audioLevel);
      console.log(`[sendChunk] ✅ Принято role=${role}: "${text}"`);
    } else {
      if (!text) {
        console.log(`[sendChunk] ❌ Отброшено role=${role} chunkIndex=${chunkIndex}: пустой текст (rawText="${rawText}")`);
      } else if (isLikelyHallucination(rawText)) {
        console.log(`[sendChunk] ❌ Отброшено role=${role} chunkIndex=${chunkIndex}: галлюцинация: "${rawText}"`);
      } else {
        console.log(`[sendChunk] ❌ Отброшено role=${role} chunkIndex=${chunkIndex}: мало кириллицы: "${text}"`);
      }
    }
    return;
  }
}

function addMessage(role, tsMs, text, chunkIndex, audioLevel = 0) {
  const msg = {
    id: state.nextId++,
    role,
    tsMs,
    lastTsMs: tsMs,
    text,
    chunkIndex,
    audioLevel,
  };
  state.messages.push(msg);
  renderMessage(msg);
  window.api.pushTranscriptLine?.({ id: msg.id, role: msg.role, tsMs: msg.tsMs, text: msg.text });
}

function addOrMergeMessage(role, tsMs, text, chunkIndex, audioLevel = 0) {
  const dedupeResult = resolveCrossRoleDuplicate(role, tsMs, text, chunkIndex, audioLevel);
  if (dedupeResult?.handled) {
    return;
  }
  const sameRoleDedupe = resolveSameRoleDuplicate(role, tsMs, text, chunkIndex, audioLevel);
  if (sameRoleDedupe?.handled) {
    return;
  }
  const last = state.messages[state.messages.length - 1];
  if (canMergeWithLast(last, role, tsMs)) {
    last.text = mergeChunkText(last.text, text);
    last.lastTsMs = tsMs;
    last.chunkIndex = chunkIndex;
    last.audioLevel = Math.max(last.audioLevel || 0, audioLevel);
    updateMessage(last);
    window.api.pushTranscriptLine?.({
      id: last.id,
      role: last.role,
      tsMs: last.tsMs,
      text: last.text,
    });
    return;
  }
  addMessage(role, tsMs, text, chunkIndex, audioLevel);
}

function canMergeWithLast(last, role, tsMs) {
  if (!last) return false;
  if (last.role !== role) return false;
  if (last.text.startsWith("[")) return false;
  const gapMs = tsMs - last.lastTsMs;
  return gapMs >= 0 && gapMs <= MERGE_GAP_MS;
}

function mergeChunkText(currentText, nextText) {
  const current = currentText.trim();
  const incoming = nextText.trim();
  if (!current) return incoming;
  if (!incoming) return current;

  if (incoming.startsWith(current)) return incoming;
  if (current.startsWith(incoming)) return current;

  const currentWords = current.split(/\s+/);
  const incomingWords = incoming.split(/\s+/);
  const normalizedCurrent = currentWords.map(normalizeWord);
  const normalizedIncoming = incomingWords.map(normalizeWord);
  const maxOverlap = Math.min(MAX_OVERLAP_WORDS, currentWords.length, incomingWords.length);
  let overlap = 0;

  for (let size = maxOverlap; size >= 1; size--) {
    const currentTail = normalizedCurrent.slice(normalizedCurrent.length - size);
    const incomingHead = normalizedIncoming.slice(0, size);
    if (currentTail.join(" ") === incomingHead.join(" ")) {
      overlap = size;
      break;
    }
  }

  if (overlap < MIN_APPEND_OVERLAP_WORDS) {
    const suffixOverlap = findBestSuffixOverlap(current, incoming);
    if (suffixOverlap > 0) {
      return current + incoming.slice(suffixOverlap);
    }
    return joinTranscriptParts(current, incoming);
  }

  const incomingTail = incomingWords.slice(overlap).join(" ");
  if (!incomingTail) return current;
  return joinTranscriptParts(current, incomingTail);
}

function normalizeWord(word) {
  // Keep Unicode letters/numbers (incl. Cyrillic) and trim boundary punctuation.
  return word
    .toLowerCase()
    .replace(/^[^\p{L}\p{N}]+/gu, "")
    .replace(/[^\p{L}\p{N}]+$/gu, "");
}

function findBestSuffixOverlap(currentText, nextText) {
  const maxLen = Math.min(currentText.length, nextText.length, 80);
  for (let size = maxLen; size >= 6; size--) {
    const currentTail = currentText.slice(-size);
    const incomingHead = nextText.slice(0, size);
    if (normalizeSpan(currentTail) === normalizeSpan(incomingHead)) {
      return size;
    }
  }
  return 0;
}

function normalizeSpan(text) {
  return text
    .toLowerCase()
    .replace(/[ё]/g, "е")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function joinTranscriptParts(current, addition) {
  if (!addition) return current;
  const spacer = /[\s-]$/.test(current) || /^[,.;:!?)]/.test(addition) ? "" : " ";
  return current + spacer + addition;
}

function resolveCrossRoleDuplicate(role, tsMs, text, chunkIndex, audioLevel) {
  const duplicate = findCrossRoleDuplicate(role, tsMs, text);
  if (!duplicate) return { handled: false };

  const existingLevel = duplicate.audioLevel || 0;
  const canPromote =
    audioLevel > 0 &&
    (existingLevel <= 0 || audioLevel >= existingLevel * CROSS_ROLE_PROMOTION_RATIO);

  if (canPromote) {
    duplicate.role = role;
    duplicate.text = pickRicherTranscript(duplicate.text, text);
    duplicate.tsMs = tsMs;
    duplicate.lastTsMs = tsMs;
    duplicate.chunkIndex = chunkIndex;
    duplicate.audioLevel = audioLevel;
    console.warn(
      `[audio] Reassigned duplicate transcript to ${role}; stronger signal ${audioLevel.toFixed(4)} vs ${existingLevel.toFixed(4)}`,
    );
    updateMessage(duplicate);
    window.api.pushTranscriptLine?.({
      id: duplicate.id,
      role: duplicate.role,
      tsMs: duplicate.tsMs,
      text: duplicate.text,
    });
    return { handled: true };
  }

  console.warn(
    `[audio] Dropped duplicate transcript for ${role}; matched recent ${duplicate.role} line with signal ${existingLevel.toFixed(4)} vs ${audioLevel.toFixed(4)}`,
  );
  return { handled: true };
}

function resolveSameRoleDuplicate(role, tsMs, text, chunkIndex, audioLevel) {
  const duplicate = findSameRoleDuplicate(role, tsMs, text, audioLevel);
  if (!duplicate) return { handled: false };

  const { message, reason } = duplicate;
  const richerText = pickRicherTranscript(message.text, text);
  const shouldRefresh = richerText !== message.text;
  message.text = richerText;
  message.lastTsMs = Math.max(message.lastTsMs ?? message.tsMs, tsMs);
  message.chunkIndex = Math.max(message.chunkIndex ?? 0, chunkIndex);
  message.audioLevel = Math.max(message.audioLevel || 0, audioLevel);

  if (shouldRefresh) {
    updateMessage(message);
    window.api.pushTranscriptLine?.({
      id: message.id,
      role: message.role,
      tsMs: message.tsMs,
      text: message.text,
    });
  }

  console.warn(`[audio] Dropped repeated ${role} transcript (${reason}).`);
  return { handled: true };
}

function findCrossRoleDuplicate(role, tsMs, text) {
  if (!isEligibleForCrossRoleDedup(text)) return null;
  for (let i = state.messages.length - 1; i >= 0; i--) {
    const msg = state.messages[i];
    if (msg.role === role) continue;
    if (msg.text.startsWith("[")) continue;
    if (Math.abs((msg.lastTsMs ?? msg.tsMs) - tsMs) > CROSS_ROLE_DUP_WINDOW_MS) continue;
    if (areLikelySameUtterance(msg.text, text)) return msg;
  }
  return null;
}

function findSameRoleDuplicate(role, tsMs, text, audioLevel) {
  if (!isEligibleForCrossRoleDedup(text)) return null;
  for (let i = state.messages.length - 1; i >= 0; i--) {
    const msg = state.messages[i];
    if (msg.role !== role) continue;
    if (msg.text.startsWith("[")) continue;
    const lastTs = msg.lastTsMs ?? msg.tsMs;
    const gapMs = Math.abs(lastTs - tsMs);
    if (gapMs > SAME_ROLE_DUP_WINDOW_MS) continue;
    if (!areLikelySameUtterance(msg.text, text)) continue;

    if (hasInterveningOtherRoleMessage(i, role)) {
      return { message: msg, reason: "same-role echo after another speaker" };
    }

    const existingLevel = msg.audioLevel || 0;
    if (
      gapMs <= SAME_ROLE_ECHO_WINDOW_MS &&
      audioLevel > 0 &&
      existingLevel > 0 &&
      audioLevel <= existingLevel * SAME_ROLE_WEAKER_RATIO
    ) {
      return { message: msg, reason: "same-role weaker echo" };
    }
  }
  return null;
}

function hasInterveningOtherRoleMessage(index, role) {
  for (let i = index + 1; i < state.messages.length; i++) {
    if (state.messages[i].role !== role) return true;
  }
  return false;
}

function isEligibleForCrossRoleDedup(text) {
  const normalized = normalizeSpan(text);
  if (normalized.length < CROSS_ROLE_DUP_MIN_CHARS) return false;
  return normalized.split(" ").filter(Boolean).length >= CROSS_ROLE_DUP_MIN_WORDS;
}

function areLikelySameUtterance(a, b) {
  const left = normalizeSpan(a);
  const right = normalizeSpan(b);
  if (!left || !right) return false;
  if (left === right) return true;
  if (
    (left.includes(right) || right.includes(left)) &&
    Math.min(left.length, right.length) >= CROSS_ROLE_DUP_MIN_CHARS
  ) {
    return true;
  }

  const leftWords = left.split(" ").filter(Boolean);
  const rightWords = right.split(" ").filter(Boolean);
  const shared = countSharedWords(leftWords, rightWords);
  if (shared < CROSS_ROLE_DUP_MIN_WORDS) return false;
  return shared / Math.min(leftWords.length, rightWords.length) >= 0.8;
}

function countSharedWords(leftWords, rightWords) {
  const rightCounts = new Map();
  for (const word of rightWords) {
    rightCounts.set(word, (rightCounts.get(word) || 0) + 1);
  }
  let shared = 0;
  for (const word of leftWords) {
    const count = rightCounts.get(word) || 0;
    if (count <= 0) continue;
    shared++;
    rightCounts.set(word, count - 1);
  }
  return shared;
}

function pickRicherTranscript(existingText, nextText) {
  if (!existingText) return nextText;
  if (!nextText) return existingText;
  if (existingText.length === nextText.length) return nextText;
  return existingText.length > nextText.length ? existingText : nextText;
}

function renderMessage(msg) {
  const node = document.createElement("div");
  node.className = "msg";
  node.dataset.id = String(msg.id);
  node.innerHTML =
    `<span class="badge ${msg.role === "HR" ? "hr" : "cand"}">${msg.role}</span>` +
    `<span class="ts">[${fmtTs(msg.tsMs)}]</span>` +
    `<span class="text"></span>`;
  node.querySelector(".text").textContent = msg.text;
  els.log.appendChild(node);
  els.log.scrollTop = els.log.scrollHeight;
  toggleDownload();
}

function updateMessage(msg) {
  const node = els.log.querySelector(`[data-id="${msg.id}"]`);
  if (!node) return;
  const badge = node.querySelector(".badge");
  badge.textContent = msg.role;
  badge.className = `badge ${msg.role === "HR" ? "hr" : "cand"}`;
  node.querySelector(".ts").textContent = `[${fmtTs(msg.tsMs)}]`;
  node.querySelector(".text").textContent = msg.text;
  node.classList.remove("typing");
  els.log.scrollTop = els.log.scrollHeight;
  toggleDownload();
}

function removeMessage(id) {
  const node = els.log.querySelector(`[data-id="${id}"]`);
  node?.remove();
  toggleDownload();
}

function fmtTs(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(s / 60);
  return String(m).padStart(2, "0") + ":" + String(s % 60).padStart(2, "0");
}

function clampSensitivityLevel(level) {
  const safeLevel = Number.isFinite(level) ? Math.round(level) : DEFAULT_SENSITIVITY_LEVEL;
  return Math.min(SENSITIVITY_MAX_LEVEL, Math.max(SENSITIVITY_MIN_LEVEL, safeLevel));
}

function mapLegacySensitivityLevel(level) {
  if (!Number.isFinite(level) || level <= 0) return DEFAULT_SENSITIVITY_LEVEL;
  const legacyClamped = Math.min(5, Math.max(1, Math.round(level)));
  if (legacyClamped === 3) return DEFAULT_SENSITIVITY_LEVEL;
  return clampSensitivityLevel(
    SENSITIVITY_MIN_LEVEL +
      ((legacyClamped - 1) * (SENSITIVITY_MAX_LEVEL - SENSITIVITY_MIN_LEVEL)) / 4,
  );
}

function loadStoredSensitivityLevel(config, fallbackLevel) {
  const stored = Number(localStorage.getItem(config.storageKey));
  if (Number.isFinite(stored) && stored > 0) return clampSensitivityLevel(stored);
  return clampSensitivityLevel(fallbackLevel);
}

function applySensitivityLevel(role, level) {
  const config = ROLE_SENSITIVITY_SETTINGS[role];
  if (!config) return;
  const safeLevel = clampSensitivityLevel(level);
  config.input.value = String(safeLevel);
  config.value.textContent = String(safeLevel);
  localStorage.setItem(config.storageKey, String(safeLevel));
  roleSilenceProfiles[role] = createSensitivityProfile(safeLevel);
}

function createSensitivityProfile(level) {
  const t =
    (clampSensitivityLevel(level) - SENSITIVITY_MIN_LEVEL) /
    (SENSITIVITY_MAX_LEVEL - SENSITIVITY_MIN_LEVEL);
  return {
    rms: lerp(SENSITIVITY_PROFILE_MIN.rms, SENSITIVITY_PROFILE_MAX.rms, t),
    peak: lerp(SENSITIVITY_PROFILE_MIN.peak, SENSITIVITY_PROFILE_MAX.peak, t),
    voiced: lerp(SENSITIVITY_PROFILE_MIN.voiced, SENSITIVITY_PROFILE_MAX.voiced, t),
    voiceFloor: lerp(SENSITIVITY_PROFILE_MIN.voiceFloor, SENSITIVITY_PROFILE_MAX.voiceFloor, t),
  };
}

function getSilenceProfile(role) {
  return roleSilenceProfiles[role] || createSensitivityProfile(DEFAULT_SENSITIVITY_LEVEL);
}

function lerp(from, to, ratio) {
  return from + (to - from) * ratio;
}

// -------- save --------

function buildTranscriptText() {
  const header = `Транскрипция встречи — ${formatNovosibirskDateTime(new Date())}\n\n`;
  const ordered = [...state.messages]
    .filter((m) => m.text.trim().length > 0)
    .sort((a, b) => a.tsMs - b.tsMs);
  const lines = ordered.map((m) => `[${fmtTs(m.tsMs)}] ${m.role}: ${m.text}`);
  return header + lines.join("\n") + "\n";
}

async function saveTranscript(afterStop) {
  const content = buildTranscriptText();
  if (!content.trim()) return;
  try {
    const res = await window.api.saveTranscript({
      content,
      defaultName: `Транскрипция_${new Date()
        .toISOString()
        .slice(0, 16)
        .replace(/[:T]/g, "-")}.txt`,
    });
    if (res?.saved && !afterStop) {
      showBanner("Сохранено: " + res.path);
      setTimeout(hideBanner, 3000);
    }
  } catch (e) {
    showBanner("Не удалось сохранить: " + e.message);
  }
}

// -------- history panel --------

// Filename of the session currently open in the viewer (for save).
let _viewerFilename = null;

async function openHistoryPanel() {
  els.historyPanel.classList.remove("hidden");
  await refreshHistoryList();
}

function closeHistoryPanel() {
  els.historyPanel.classList.add("hidden");
  els.historyViewer.classList.add("hidden");
}

function updateMultiselectBar() {
  const checked = els.historyList.querySelectorAll(".history-select:checked");
  const count = checked.length;
  if (count > 0) {
    els.historyMultiselectBar.classList.remove("hidden");
    els.historySelectedCount.textContent = `${count} выбрано`;
  } else {
    els.historyMultiselectBar.classList.add("hidden");
  }
}

async function deleteSelectedSessions() {
  const checked = Array.from(els.historyList.querySelectorAll(".history-select:checked"));
  if (checked.length === 0) return;
  if (!confirm(`Удалить ${checked.length} запис${checked.length === 1 ? "ь" : "и"}?`)) return;
  for (const cb of checked) {
    try {
      await window.api.deleteSession(cb.dataset.file);
    } catch (err) {
      showBanner(`Не удалось удалить ${cb.dataset.file}: ${err.message}`);
    }
  }
  await refreshHistoryList();
}

async function refreshHistoryList() {
  els.historyList.innerHTML = '<p class="history-loading">Загрузка…</p>';
  els.historyMultiselectBar.classList.add("hidden");
  let sessions = [];
  try {
    sessions = await window.api.listSessions();
  } catch (e) {
    els.historyList.innerHTML = '<p class="history-loading">Ошибка загрузки истории.</p>';
    return;
  }

  const filtered = state.historyTab === "favorites" ? sessions.filter((s) => s.favorite) : sessions;

  if (filtered.length === 0) {
    els.historyList.innerHTML =
      state.historyTab === "favorites"
        ? '<p class="history-loading">Нет избранных записей.</p>'
        : '<p class="history-loading">Сохранённых записей нет.</p>';
    return;
  }
  els.historyList.innerHTML = "";
  for (const s of filtered) {
    const row = document.createElement("div");
    row.className = "history-row";

    const datePart = s.filename.replace(/^session_/, "").replace(/\.txt$/, "");
    const dateLabel = formatSessionDate(datePart);
    const chronologicalIndex = sessions.length - sessions.indexOf(s);
    const defaultName = `Запись ${chronologicalIndex}`;
    const displayLabel = s.label ? escapeHtml(s.label) : defaultName;
    const kb = Math.round((s.size / 1024) * 10) / 10;
    const starLabel = s.favorite ? "★" : "☆";
    const starClass = s.favorite ? "history-star active" : "history-star";

    row.innerHTML =
      `<label class="history-checkbox-wrap" title="Выбрать">` +
      `<input type="checkbox" class="history-select" data-file="${s.filename}">` +
      `</label>` +
      `<div class="history-row-body">` +
      `<div class="history-info">` +
      `<div class="history-info-text">` +
      `<span class="history-name" title="${dateLabel}">${displayLabel}</span>` +
      `<span class="history-date">${dateLabel}</span>` +
      `</div>` +
      `<span class="history-size">${kb} КБ</span>` +
      `</div>` +
      `<div class="history-actions">` +
      `<button class="${starClass}" data-action="favorite" data-file="${s.filename}" title="Добавить в избранное">${starLabel}</button>` +
      `<button class="btn ghost history-btn" data-action="rename" data-file="${s.filename}" data-label="${escapeHtml(s.label || "")}" data-default="${escapeHtml(defaultName)}">✏</button>` +
      `<button class="btn ghost history-btn" data-action="view" data-file="${s.filename}" data-title="${displayLabel}" data-date="${dateLabel}">Открыть</button>` +
      `<button class="btn primary history-btn" data-action="continue" data-file="${s.filename}" data-title="${displayLabel}" data-date="${dateLabel}">Продолжить</button>` +
      `<button class="btn danger history-btn" data-action="delete" data-file="${s.filename}">Удалить</button>` +
      `</div>` +
      `</div>`;
    els.historyList.appendChild(row);
  }

  // Update multiselect bar whenever a checkbox changes.
  els.historyList.querySelectorAll(".history-select").forEach((cb) => {
    cb.addEventListener("change", updateMultiselectBar);
  });

  els.historyList.removeEventListener("click", onHistoryAction);
  els.historyList.addEventListener("click", onHistoryAction);
}

async function onHistoryAction(e) {
  // Don't trigger on checkbox clicks (they're handled separately).
  if (e.target.classList.contains("history-select")) return;

  const btn = e.target.closest("[data-action]");
  if (!btn) return;
  const action = btn.dataset.action;
  const filename = btn.dataset.file;

  if (action === "favorite") {
    try {
      await window.api.toggleFavorite(filename);
      await refreshHistoryList();
    } catch (err) {
      showBanner("Не удалось обновить избранное: " + err.message);
    }
    return;
  }

  if (action === "rename") {
    openRenameModal(filename, btn.dataset.label || btn.dataset.default || "");
    return;
  }

  if (action === "delete") {
    if (
      !confirm(`Удалить запись «${formatSessionDate(filename.replace(/^session_|\.txt$/g, ""))}»?`)
    )
      return;
    try {
      await window.api.deleteSession(filename);
      await refreshHistoryList();
    } catch (err) {
      showBanner("Не удалось удалить: " + err.message);
    }
    return;
  }

  let content = "";
  let comment = "";
  try {
    const res = await window.api.loadSession(filename);
    content = res.content || "";
    comment = res.comment || "";
  } catch (err) {
    showBanner("Не удалось открыть: " + err.message);
    return;
  }

  if (action === "view") {
    openViewerForSession(filename, content, comment, btn.dataset.title, btn.dataset.date);
    return;
  }

  if (action === "continue") {
    if (state.recording) {
      showBanner("Сначала остановите текущую запись.");
      return;
    }
    const loaded = parseTranscriptContent(content);
    state.messages = loaded;
    state.nextId = loaded.length + 1;
    els.log.innerHTML = "";
    for (const msg of loaded) {
      renderMessage(msg);
    }
    const maxTs = loaded.reduce((m, msg) => Math.max(m, msg.tsMs), 0);
    state.startedAt = performance.now() - maxTs - 2000;
    _currentSessionFile = filename;
    closeHistoryPanel();
    showBanner(
      `Продолжение записи «${btn.dataset.title || btn.dataset.date || filename}». Нажмите «Начать запись».`,
    );
  }
}

// Open the editable viewer for a session.
function openViewerForSession(filename, content, comment, title, dateLabel) {
  _viewerFilename = filename;
  els.historyViewerTitle.textContent = title || filename;
  if (dateLabel) {
    els.historyViewerMeta.textContent = dateLabel;
    els.historyViewerMeta.classList.remove("hidden");
  } else {
    els.historyViewerMeta.textContent = "";
    els.historyViewerMeta.classList.add("hidden");
  }
  els.historyViewerComment.value = comment;

  // Render editable lines.
  const lines = content.split("\n");
  const RE = /^\[(\d{2}:\d{2})\]\s+(HR|Кандидат):\s+(.*)$/;
  els.historyViewerContent.innerHTML = "";
  for (const line of lines) {
    const m = line.match(RE);
    if (!m) continue;
    const ts = m[1];
    const role = m[2];
    const text = m[3];

    const lineEl = document.createElement("div");
    lineEl.className = "viewer-line";
    lineEl.dataset.ts = ts;

    const roleEl = document.createElement("select");
    roleEl.className = `viewer-role viewer-role-${role === "HR" ? "hr" : "cand"}`;
    ["HR", "Кандидат"].forEach((r) => {
      const opt = document.createElement("option");
      opt.value = r;
      opt.textContent = r;
      if (r === role) opt.selected = true;
      roleEl.appendChild(opt);
    });
    roleEl.addEventListener("change", () => {
      roleEl.className = `viewer-role viewer-role-${roleEl.value === "HR" ? "hr" : "cand"}`;
    });

    const tsEl = document.createElement("span");
    tsEl.className = "viewer-ts";
    tsEl.textContent = `[${ts}]`;

    const textEl = document.createElement("textarea");
    textEl.className = "viewer-text";
    textEl.value = text;
    textEl.rows = 1;
    // Auto-resize on input.
    textEl.addEventListener("input", () => {
      textEl.style.height = "auto";
      textEl.style.height = textEl.scrollHeight + "px";
    });

    lineEl.appendChild(roleEl);
    lineEl.appendChild(tsEl);
    lineEl.appendChild(textEl);
    els.historyViewerContent.appendChild(lineEl);

    // Trigger initial sizing.
    setTimeout(() => {
      textEl.style.height = "auto";
      textEl.style.height = textEl.scrollHeight + "px";
    }, 0);
  }

  els.historyViewer.classList.remove("hidden");
}

// Serialize viewer lines back to transcript format and save.
async function saveViewerSession() {
  if (!_viewerFilename) return;
  const lines = els.historyViewerContent.querySelectorAll(".viewer-line");
  const content = Array.from(lines)
    .map((line) => {
      const ts = line.dataset.ts;
      const role = line.querySelector(".viewer-role").value;
      const text = line.querySelector(".viewer-text").value.replace(/\n/g, " ").trim();
      return `[${ts}] ${role}: ${text}`;
    })
    .join("\n");
  const comment = els.historyViewerComment.value;
  try {
    await Promise.all([
      window.api.saveSession(_viewerFilename, content),
      window.api.saveComment(_viewerFilename, comment),
    ]);
    showBanner("Запись сохранена.");
    setTimeout(hideBanner, 2500);
  } catch (err) {
    showBanner("Не удалось сохранить: " + err.message);
  }
}

function parseTranscriptContent(content) {
  const messages = [];
  const lines = content.split("\n");
  const RE = /^\[(\d{2}):(\d{2})\]\s+(HR|Кандидат):\s+(.+)$/;
  for (const line of lines) {
    const m = line.match(RE);
    if (!m) continue;
    const tsMs = (parseInt(m[1]) * 60 + parseInt(m[2])) * 1000;
    messages.push({
      id: messages.length + 1,
      role: m[3],
      tsMs,
      lastTsMs: tsMs,
      text: m[4].trim(),
      chunkIndex: 0,
    });
  }
  return messages;
}

function formatSessionDate(datePart) {
  // datePart: "2026-07-28-12-30-45"
  const parts = datePart.split("-");
  if (parts.length >= 6) {
    return `${parts[2]}.${parts[1]}.${parts[0]} ${parts[3]}:${parts[4]}:${parts[5]}`;
  }
  if (parts.length >= 3) {
    return `${parts[2]}.${parts[1]}.${parts[0]}`;
  }
  return datePart;
}

function formatNovosibirskDateTime(date) {
  return new Intl.DateTimeFormat("ru-RU", {
    timeZone: "Asia/Novosibirsk",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(date);
}

function formatSessionStamp(date) {
  const parts = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Novosibirsk",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const map = Object.fromEntries(
    parts.filter((part) => part.type !== "literal").map((part) => [part.type, part.value]),
  );
  return `${map.year}-${map.month}-${map.day}-${map.hour}-${map.minute}-${map.second}`;
}

// Returns true if the device label suggests a Bluetooth headset/earbuds mic.
// On Windows, connecting AirPods can cause ALL enumerated microphones to be
// Bluetooth variants — the built-in mic is hidden until the Bluetooth device
// is disconnected. This helper lets us warn the user about that.
function isBluetoothMic(device) {
  const label = String(device?.label || "").toLowerCase();
  if (!label) return false;
  const btTokens = [
    "airpod",
    "bluetooth",
    "handsfree",
    "hands-free",
    "hfp",
    "headset",
    "беспровод",
    "блютус",
  ];
  return btTokens.some((t) => label.includes(t));
}

function isLikelyLoopbackInput(device) {
  const label = String(device?.label || "").toLowerCase();
  if (!label) return false;
  const include = [
    "loopback",
    "stereo mix",
    "what u hear",
    "monitor",
    "vb-audio",
    "cable output",
    "cable-a output",
    "voicemeeter",
    "blackhole",
    "soundflower",
    "virtual",
    "вирту",
  ];
  const exclude = ["microphone", "mic", "микроф", "гарнит", "headset", "webcam", "line in"];
  const explicitLoopback = include.some((token) => label.includes(token));
  if (explicitLoopback) return true;
  if (exclude.some((token) => label.includes(token))) return false;
  return false;
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// -------- rename modal --------

let _renameFilename = null;

function openRenameModal(filename, currentLabel) {
  _renameFilename = filename;
  els.renameInput.value = currentLabel;
  els.renameModal.classList.remove("hidden");
  els.renameInput.focus();
  els.renameInput.select();

  els.renameConfirm.onclick = async () => {
    const newLabel = els.renameInput.value.trim();
    const filenameToRename = _renameFilename;
    closeRenameModal();
    try {
      await window.api.renameSession(filenameToRename, newLabel);
      await refreshHistoryList();
    } catch (err) {
      showBanner("Не удалось переименовать: " + err.message);
    }
  };
}

function closeRenameModal() {
  els.renameModal.classList.add("hidden");
  _renameFilename = null;
}
