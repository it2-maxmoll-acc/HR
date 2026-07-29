// Realtime Transcriber — renderer

const CHUNK_MS = 2500; // window length
const OVERLAP_MS = 400; // overlap between chunks so words aren't cut
const SAMPLE_RATE = 16000;
// Allow one delayed chunk or network jitter before starting a new phrase line.
const MERGE_TOLERANCE_MS = 1500;
// 4s merge window total: 2.5s chunk + 1.5s tolerance.
const MERGE_GAP_MS = CHUNK_MS + MERGE_TOLERANCE_MS;
// Detect and remove up to this many repeated boundary words from overlap.
const MAX_OVERLAP_WORDS = 8;

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
  sensitivity: document.getElementById("sensitivity"),
  sensValue: document.getElementById("sens-value"),
  overlay: document.getElementById("overlay"),
  history: document.getElementById("history"),
  historyPanel: document.getElementById("history-panel"),
  historyList: document.getElementById("history-list"),
  historyClose: document.getElementById("history-close"),
  historyViewer: document.getElementById("history-viewer"),
  historyViewerContent: document.getElementById("history-viewer-content"),
  historyViewerClose: document.getElementById("history-viewer-close"),
  logsBtn: document.getElementById("logs-btn"),
  logsPanel: document.getElementById("logs-panel"),
  logsList: document.getElementById("logs-list"),
  logsClose: document.getElementById("logs-close"),
  logsCopy: document.getElementById("logs-copy"),
  logsClear: document.getElementById("logs-clear"),
};

const state = {
  recording: false,
  paused: false,
  startedAt: 0,
  timerInterval: null,
  captures: [], // { role, stream, audioCtx, source, processor, buffer, chunkIndex }
  messages: [], // { role, tsMs, lastTsMs, text, id }
  nextId: 1,
};

// Current session file for autosave (set on start, cleared on stop).
let _currentSessionFile = null;
let _autosaveInterval = null;

// -------- init --------

// Load API key from secure (OS-encrypted) storage.
window.api.loadApiKey?.().then((key) => {
  if (key) els.apiKey.value = key;
});
els.apiKey.addEventListener("change", () =>
  window.api.storeApiKey?.(els.apiKey.value.trim()),
);

const savedModel = localStorage.getItem("openai-model") || "whisper-1";
els.modelSelect.value = savedModel;
els.modelSelect.addEventListener("change", () =>
  localStorage.setItem("openai-model", els.modelSelect.value),
);

// Sensitivity 1..5 → thresholds. Higher = stricter (drops more as silence).
const SENS_PROFILES = {
  1: { rms: 0.008, peak: 0.035, voiced: 0.03 },
  2: { rms: 0.011, peak: 0.045, voiced: 0.045 },
  3: { rms: 0.016, peak: 0.06, voiced: 0.07 },
  4: { rms: 0.022, peak: 0.08, voiced: 0.1 },
  5: { rms: 0.03, peak: 0.11, voiced: 0.14 },
};
let silenceProfile = SENS_PROFILES[3];

const savedSens = Number(localStorage.getItem("sensitivity")) || 3;
els.sensitivity.value = String(savedSens);
els.sensValue.textContent = String(savedSens);
silenceProfile = SENS_PROFILES[savedSens] || SENS_PROFILES[3];
els.sensitivity.addEventListener("input", () => {
  const v = Number(els.sensitivity.value) || 3;
  els.sensValue.textContent = String(v);
  silenceProfile = SENS_PROFILES[v] || SENS_PROFILES[3];
  localStorage.setItem("sensitivity", String(v));
});

async function refreshDevices() {
  try {
    // getUserMedia once to unlock device labels.
    const probe = await navigator.mediaDevices.getUserMedia({ audio: true }).catch(() => null);
    const devices = await navigator.mediaDevices.enumerateDevices();
    const mics = devices.filter((d) => d.kind === "audioinput");
    els.mic.innerHTML = "";
    for (const m of mics) {
      const opt = document.createElement("option");
      opt.value = m.deviceId;
      opt.textContent = m.label || `Микрофон ${m.deviceId.slice(0, 6)}`;
      els.mic.appendChild(opt);
    }
    // System audio: keep loopback default, but also list any audioinput
    // devices (useful when a virtual loopback cable is installed).
    els.sys.innerHTML = "";
    const loop = document.createElement("option");
    loop.value = "loopback";
    loop.textContent = "Системный звук (весь ПК)";
    els.sys.appendChild(loop);
    for (const m of mics) {
      const opt = document.createElement("option");
      opt.value = "input:" + m.deviceId;
      opt.textContent = "Вход: " + (m.label || `устройство ${m.deviceId.slice(0, 6)}`);
      els.sys.appendChild(opt);
    }
    const savedSys = localStorage.getItem("sys-source");
    if (savedSys) els.sys.value = savedSys;
    if (probe) probe.getTracks().forEach((t) => t.stop());
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
els.logsBtn.addEventListener("click", openLogsPanel);
els.logsClose.addEventListener("click", closeLogsPanel);
els.logsClear.addEventListener("click", clearLogs);
els.logsCopy.addEventListener("click", copyLogs);

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
            try { return JSON.stringify(a, null, 2); } catch { return String(a); }
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

function copyLogs() {
  const text = _logs.map((e) => `[${e.ts}] [${e.level.toUpperCase()}] ${e.msg}`).join("\n");
  navigator.clipboard.writeText(text).catch(() => {});
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

window.api.getProxyDiagnostics?.().then(logProxyDiagnostics).catch((e) => {
  console.error("[proxy] failed to load diagnostics", e?.message || e);
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
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
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
  const micStream = await navigator.mediaDevices.getUserMedia({
    audio: {
      deviceId: micDeviceId ? { exact: micDeviceId } : undefined,
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
  });

  // System audio via getDisplayMedia (Electron 30+ with setDisplayMediaRequestHandler)
  let sysStream = null;
  const sysChoice = els.sys.value || "loopback";
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
        sendChunk(cap.role, audio, cap.startTs, cap.chunkIndex++);
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

  // Prompt user to save as .txt.
  await saveTranscript(true);
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

      const tsAtStart = cap.windowStartTs;
      const idx = cap.chunkIndex++;

      // Silence gate: skip near-silent chunks so the model doesn't hallucinate.
      if (!isSilent(chunk)) {
        const wav = encodeWav(chunk, audioCtx.sampleRate);
        sendChunk(cap.role, wav, tsAtStart, idx);
      }

      // Keep overlap tail as head of next buffer.
      const tail = merged.subarray(chunkSamples - overlapSamples);
      cap.buffer = [new Float32Array(tail)];
      cap.bufferSamples = tail.length;
      cap.windowStartTs += ((chunkSamples - overlapSamples) * 1000) / audioCtx.sampleRate;
    }
  };

  source.connect(processor);
  processor.connect(audioCtx.destination); // required for onaudioprocess to fire

  state.captures.push(cap);
}

function flushBuffer(cap) {
  const merged = mergeFloat32(cap.buffer, cap.bufferSamples);
  cap.buffer = [];
  cap.bufferSamples = 0;
  cap.startTs = cap.windowStartTs;
  return encodeWav(merged, cap.audioCtx.sampleRate);
}

// Return true if the chunk is quiet enough that we treat it as silence.
// Uses RMS + peak + "voiced ratio" (share of samples above a small floor).
// Clicks or fan noise can push peak up while the chunk is really silent,
// so we require a meaningful fraction of samples to be non-trivial.
function isSilent(samples) {
  let sumSq = 0;
  let peak = 0;
  let voiced = 0;
  const voiceFloor = 0.02;
  for (let i = 0; i < samples.length; i++) {
    const v = samples[i];
    sumSq += v * v;
    const a = v < 0 ? -v : v;
    if (a > peak) peak = a;
    if (a > voiceFloor) voiced++;
  }
  const rms = Math.sqrt(sumSq / samples.length);
  const voicedRatio = voiced / samples.length;
  // Thresholds come from the user-selected sensitivity profile.
  if (rms < silenceProfile.rms) return true;
  if (peak < silenceProfile.peak) return true;
  if (voicedRatio < silenceProfile.voiced) return true;
  return false;
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
  "bye",
  "meow",
  "uh",
  "um",
  "hmm",
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
  "спасибо",
  "пока",
  "ой",
  "ну",
]);

// Fragments of the Whisper prompt that the model sometimes echoes back verbatim.
const PROMPT_FRAGMENTS = [
  "числа пиши арабскими цифрами",
  "знаки препинания расставляй точно",
  "пиши каждое слово отдельно",
];

function isLikelyHallucination(text) {
  const normalized = text
    .toLowerCase()
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

async function sendChunk(role, wavBlob, tsMs, chunkIndex) {
  const model = els.modelSelect.value || "whisper-1";
  const apiKey = (els.apiKey.value || "").trim();
  if (!apiKey) {
    showBanner("Введите OpenAI API Key в поле выше, затем начните запись снова.");
    return;
  }

  const endpoint = "https://api.openai.com/v1/audio/transcriptions";
  const headers = { Authorization: "Bearer " + apiKey };

  const form = new FormData();
  form.append("file", wavBlob, `chunk_${chunkIndex}.wav`);
  form.append("model", model);
  form.append("language", "ru");
  form.append(
    "prompt",
    "Числа пиши арабскими цифрами. Знаки препинания расставляй точно. Пиши каждое слово отдельно.",
  );

  // Retry indefinitely on 429 (rate limit) so nothing is ever dropped.
  let attempt = 0;
  while (true) {
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
        (rawErr && typeof rawErr === "object" ? rawErr.message : rawErr) ||
        `HTTP ${res.status}`;
      console.error(`[sendChunk] error status=${res.status} msg="${errMsg}" data=${JSON.stringify(data)}`);
      // Transient server error — retry a few times before giving up.
      if (res.status >= 500 && attempt < 5) {
        attempt++;
        const delay = Math.min(Math.pow(2, attempt) * 500, 8000);
        showBanner(`Ошибка сервера OpenAI (${res.status}), повтор через ${delay / 1000}с…`);
        await _sleep(delay);
        continue;
      }
      addMessage(role, tsMs, `[ошибка: ${errMsg}]`, chunkIndex);
      return;
    }

    // Success — clear any lingering error banner.
    hideBanner();
    console.log(`[sendChunk] ok role=${role} chunkIndex=${chunkIndex}`);
    const text = (data.text || "").trim();
    if (text && !isLikelyHallucination(text) && hasEnoughCyrillic(text)) {
      addOrMergeMessage(role, tsMs, text, chunkIndex);
    }
    return;
  }
}

function addMessage(role, tsMs, text, chunkIndex) {
  const msg = {
    id: state.nextId++,
    role,
    tsMs,
    lastTsMs: tsMs,
    text,
    chunkIndex,
  };
  state.messages.push(msg);
  renderMessage(msg);
  window.api.pushTranscriptLine?.({ id: msg.id, role: msg.role, tsMs: msg.tsMs, text: msg.text });
}

function addOrMergeMessage(role, tsMs, text, chunkIndex) {
  const last = state.messages[state.messages.length - 1];
  if (canMergeWithLast(last, role, tsMs)) {
    last.text = mergeChunkText(last.text, text);
    last.lastTsMs = tsMs;
    last.chunkIndex = chunkIndex;
    updateMessage(last);
    window.api.pushTranscriptLine?.({
      id: last.id,
      role: last.role,
      tsMs: last.tsMs,
      text: last.text,
    });
    return;
  }
  addMessage(role, tsMs, text, chunkIndex);
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

  const incomingTail = incomingWords.slice(overlap).join(" ");
  if (!incomingTail) return current;
  // If current already ends with whitespace or "-", don't add an extra separator.
  const spacer = /[\s-]$/.test(current) ? "" : " ";
  return current + spacer + incomingTail;
}

function normalizeWord(word) {
  // Keep Unicode letters/numbers (incl. Cyrillic) and trim boundary punctuation.
  return word
    .toLowerCase()
    .replace(/^[^\p{L}\p{N}]+/gu, "")
    .replace(/[^\p{L}\p{N}]+$/gu, "");
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
  const t = node.querySelector(".text");
  t.textContent = msg.text;
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

// -------- save --------

function buildTranscriptText() {
  const header = `Транскрипция встречи — ${new Date().toLocaleString("ru-RU")}\n\n`;
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

async function openHistoryPanel() {
  els.historyPanel.classList.remove("hidden");
  await refreshHistoryList();
}

function closeHistoryPanel() {
  els.historyPanel.classList.add("hidden");
  els.historyViewer.classList.add("hidden");
}

async function refreshHistoryList() {
  els.historyList.innerHTML = '<p class="history-loading">Загрузка…</p>';
  let sessions = [];
  try {
    sessions = await window.api.listSessions();
  } catch (e) {
    els.historyList.innerHTML = '<p class="history-loading">Ошибка загрузки истории.</p>';
    return;
  }
  if (sessions.length === 0) {
    els.historyList.innerHTML = '<p class="history-loading">Сохранённых записей нет.</p>';
    return;
  }
  els.historyList.innerHTML = "";
  for (const s of sessions) {
    const row = document.createElement("div");
    row.className = "history-row";

    // Format filename → readable date
    const datePart = s.filename.replace(/^session_/, "").replace(/\.txt$/, "");
    // datePart: 2026-07-28T12-30-45 → 28.07.2026 12:30:45
    const label = formatSessionDate(datePart);
    const kb = Math.round(s.size / 1024 * 10) / 10;

    row.innerHTML =
      `<div class="history-info">` +
        `<span class="history-name">${label}</span>` +
        `<span class="history-size">${kb} КБ</span>` +
      `</div>` +
      `<div class="history-actions">` +
        `<button class="btn ghost history-btn" data-action="view" data-file="${s.filename}">Открыть</button>` +
        `<button class="btn primary history-btn" data-action="continue" data-file="${s.filename}">Продолжить</button>` +
        `<button class="btn danger history-btn" data-action="delete" data-file="${s.filename}">Удалить</button>` +
      `</div>`;
    els.historyList.appendChild(row);
  }

  els.historyList.addEventListener("click", onHistoryAction);
}

async function onHistoryAction(e) {
  const btn = e.target.closest("[data-action]");
  if (!btn) return;
  const action = btn.dataset.action;
  const filename = btn.dataset.file;

  if (action === "delete") {
    if (!confirm(`Удалить запись «${formatSessionDate(filename.replace(/^session_|\.txt$/g, ""))}»?`)) return;
    try {
      await window.api.deleteSession(filename);
      await refreshHistoryList();
    } catch (err) {
      showBanner("Не удалось удалить: " + err.message);
    }
    return;
  }

  let content = "";
  try {
    const res = await window.api.loadSession(filename);
    content = res.content || "";
  } catch (err) {
    showBanner("Не удалось открыть: " + err.message);
    return;
  }

  if (action === "view") {
    els.historyViewerContent.textContent = content || "(пусто)";
    els.historyViewer.classList.remove("hidden");
    return;
  }

  if (action === "continue") {
    if (state.recording) {
      showBanner("Сначала остановите текущую запись.");
      return;
    }
    // Parse existing messages from file and restore them.
    const loaded = parseTranscriptContent(content);
    state.messages = loaded;
    state.nextId = loaded.length + 1;
    els.log.innerHTML = "";
    for (const msg of loaded) {
      renderMessage(msg);
    }
    // Offset timer so new recording continues from where old one left off.
    const maxTs = loaded.reduce((m, msg) => Math.max(m, msg.tsMs), 0);
    state.startedAt = performance.now() - maxTs - 2000;
    _currentSessionFile = filename;
    closeHistoryPanel();
    showBanner("Продолжение записи «" + formatSessionDate(filename.replace(/^session_|\.txt$/g, "")) + "». Нажмите «Начать запись».");
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
