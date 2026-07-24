// Realtime Transcriber — renderer

const DEFAULT_ENDPOINT =
  "https://real-time-talk-scribe.lovable.app/api/public/transcribe";

const CHUNK_MS = 2500; // window length
const OVERLAP_MS = 400; // overlap between chunks so words aren't cut
const SAMPLE_RATE = 16000;

const els = {
  status: document.getElementById("status"),
  timer: document.getElementById("timer"),
  mic: document.getElementById("mic-select"),
  sys: document.getElementById("sys-select"),
  endpoint: document.getElementById("endpoint"),
  start: document.getElementById("start"),
  stop: document.getElementById("stop"),
  save: document.getElementById("save"),
  download: document.getElementById("download"),
  banner: document.getElementById("banner"),
  log: document.getElementById("log"),
  sensitivity: document.getElementById("sensitivity"),
  sensValue: document.getElementById("sens-value"),
};

const state = {
  recording: false,
  startedAt: 0,
  timerInterval: null,
  captures: [], // { role, stream, audioCtx, source, processor, buffer, chunkIndex }
  messages: [], // { role, tsMs, text, id, pending }
  nextId: 1,
};

// -------- init --------

const savedEndpoint = localStorage.getItem("endpoint");
if (savedEndpoint && savedEndpoint.includes("ea3a71b5-4e0b-4c46-958e-e3204c5abc7d")) {
  localStorage.removeItem("endpoint");
}
els.endpoint.value = localStorage.getItem("endpoint") || DEFAULT_ENDPOINT;
els.endpoint.addEventListener("change", () =>
  localStorage.setItem("endpoint", els.endpoint.value.trim()),
);

// Sensitivity 1..5 → thresholds. Higher = stricter (drops more as silence).
const SENS_PROFILES = {
  1: { rms: 0.008, peak: 0.035, voiced: 0.03 },
  2: { rms: 0.011, peak: 0.045, voiced: 0.045 },
  3: { rms: 0.016, peak: 0.06,  voiced: 0.07 },
  4: { rms: 0.022, peak: 0.08,  voiced: 0.1 },
  5: { rms: 0.03,  peak: 0.11,  voiced: 0.14 },
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
    const probe = await navigator.mediaDevices
      .getUserMedia({ audio: true })
      .catch(() => null);
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
      opt.textContent =
        "Вход: " + (m.label || `устройство ${m.deviceId.slice(0, 6)}`);
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
els.sys.addEventListener("change", () =>
  localStorage.setItem("sys-source", els.sys.value),
);
els.mic.addEventListener("change", () =>
  localStorage.setItem("mic-source", els.mic.value),
);

// -------- controls --------

els.start.addEventListener("click", () => start().catch(handleFatal));
els.stop.addEventListener("click", () => stop().catch(handleFatal));
els.save.addEventListener("click", () => saveTranscript(false));
els.download.addEventListener("click", () => saveTranscript(false));

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
  const hasContent = state.messages.some(
    (m) => !m.pending || m.text !== "…",
  );
  els.download.disabled = !hasContent;
}

// -------- recording lifecycle --------

async function start() {
  if (state.recording) return;
  hideBanner();
  els.start.disabled = true;
  els.stop.disabled = false;
  els.save.disabled = false;

  state.recording = true;
  state.startedAt = performance.now();
  state.messages = [];
  state.nextId = 1;
  els.log.innerHTML = "";
  toggleDownload();

  updateStatus(true);
  state.timerInterval = setInterval(tickTimer, 500);

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
  updateStatus(false);

  clearInterval(state.timerInterval);
  state.timerInterval = null;

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

  // Autosave.
  try {
    const content = buildTranscriptText();
    if (content.trim()) {
      await window.api.autosaveTranscript({ content });
    }
  } catch (e) {
    console.warn("autosave", e);
  }

  // Prompt user to save.
  await saveTranscript(true);
}

function updateStatus(recording) {
  els.status.textContent = recording ? "● Идёт запись" : "Готов к записи";
  els.status.classList.toggle("recording", recording);
}

function tickTimer() {
  const s = Math.floor((performance.now() - state.startedAt) / 1000);
  const m = Math.floor(s / 60);
  els.timer.textContent =
    String(m).padStart(2, "0") + ":" + String(s % 60).padStart(2, "0");
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

  const chunkSamples = Math.round(
    (audioCtx.sampleRate * CHUNK_MS) / 1000,
  );
  const overlapSamples = Math.round(
    (audioCtx.sampleRate * OVERLAP_MS) / 1000,
  );

  processor.onaudioprocess = (e) => {
    if (!state.recording) return;
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
      cap.windowStartTs +=
        ((chunkSamples - overlapSamples) * 1000) / audioCtx.sampleRate;
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
  "hi", "hello", "hey", "ok", "okay", "yeah", "yes", "no", "thanks",
  "thank you", "bye", "meow", "uh", "um", "hmm", "mhm", "oh", "wow",
  "you", "the", "so", "well", "right",
  "привет", "да", "нет", "ага", "угу", "спасибо", "пока", "ой", "ну",
]);

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
  return false;
}

// Keep only transcripts that look like English or Russian.
// Anything dominated by CJK / Korean / Arabic / etc is a hallucination on silence.
function isEnglishOrRussian(text) {
  if (!text) return false;
  const letters = text.match(/\p{L}/gu) || [];
  if (letters.length === 0) return false;
  let good = 0;
  for (const ch of letters) {
    // Latin (English) or Cyrillic (Russian)
    if (/[A-Za-z\u0400-\u04FF]/.test(ch)) good++;
  }
  return good / letters.length >= 0.6;
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

// -------- send + render --------

async function sendChunk(role, wavBlob, tsMs, chunkIndex) {
  const id = state.nextId++;
  const msg = {
    id,
    role,
    tsMs,
    text: "…",
    pending: true,
    chunkIndex,
  };
  state.messages.push(msg);
  renderMessage(msg);

  const endpoint = (els.endpoint.value || DEFAULT_ENDPOINT).trim();

  const form = new FormData();
  form.append("file", wavBlob, `chunk_${chunkIndex}.wav`);
  form.append("role", role);
  form.append("chunk_index", String(chunkIndex));
  // Language is auto-detected; we filter to EN/RU below.

  try {
    const res = await fetch(endpoint, { method: "POST", body: form });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const detail =
        data?.error || data?.detail?.error?.message || `HTTP ${res.status}`;
      msg.text = "[ошибка: " + detail + "]";
      msg.pending = false;
      if (res.status === 402) {
        showBanner("Кредиты Lovable AI закончились. Пополните и продолжите.");
      } else if (res.status === 429) {
        showBanner("Слишком много запросов, замедляем поток.");
      }
    } else {
      const text = (data.text || "").trim();
      if (text && isEnglishOrRussian(text)) {
        msg.text = text;
        msg.pending = false;
      } else {
        // Drop empty output or non-EN/RU noise. Silence is already gated
        // by isSilent() before sending, so short real words like "да"/"нет"
        // reach here only when the user actually spoke.
        state.messages = state.messages.filter((m) => m.id !== id);
        removeMessage(id);
        return;
      }

    }
  } catch (e) {
    msg.text = "[сеть недоступна]";
    msg.pending = false;
  }
  updateMessage(msg);
}

function renderMessage(msg) {
  const node = document.createElement("div");
  node.className = "msg";
  node.dataset.id = String(msg.id);
  node.innerHTML =
    `<span class="badge ${msg.role === "HR" ? "hr" : "cand"}">${msg.role}</span>` +
    `<span class="ts">[${fmtTs(msg.tsMs)}]</span>` +
    `<span class="text ${msg.pending ? "pending" : ""}"></span>`;
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
  t.classList.toggle("pending", msg.pending);
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
    .filter((m) => !m.pending || m.text !== "…")
    .sort((a, b) => a.tsMs - b.tsMs);
  const lines = ordered.map(
    (m) => `[${fmtTs(m.tsMs)}] ${m.role}: ${m.text}`,
  );
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