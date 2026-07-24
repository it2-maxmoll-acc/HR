// Overlay renderer — shows the live transcript in a small always-on-top window.

const container = document.getElementById("container");
const logEl = document.getElementById("log");
const opacitySlider = document.getElementById("opacity-slider");
const closeBtn = document.getElementById("close-btn");

// Restore saved opacity (persists across overlay opens via localStorage).
const savedOpacity = localStorage.getItem("overlay-opacity");
if (savedOpacity) {
  opacitySlider.value = savedOpacity;
  applyOpacity(Number(savedOpacity));
}

opacitySlider.addEventListener("input", () => {
  const v = Number(opacitySlider.value);
  applyOpacity(v);
  localStorage.setItem("overlay-opacity", String(v));
});

closeBtn.addEventListener("click", () => window.close());

function applyOpacity(percent) {
  // Only change background alpha so text stays fully readable at low opacity.
  container.style.background = `rgba(11, 13, 16, ${percent / 100})`;
}

function fmtTs(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(s / 60);
  return String(m).padStart(2, "0") + ":" + String(s % 60).padStart(2, "0");
}

function upsertMessage(msg) {
  const existing = logEl.querySelector(`[data-id="${msg.id}"]`);
  if (existing) {
    existing.querySelector(".text").textContent = msg.text;
    logEl.scrollTop = logEl.scrollHeight;
    return;
  }
  const node = document.createElement("div");
  node.className = "msg";
  node.dataset.id = String(msg.id);
  const isHR = msg.role === "HR";
  node.innerHTML =
    `<span class="badge ${isHR ? "hr" : "cand"}">${msg.role}</span>` +
    `<span class="ts">[${fmtTs(msg.tsMs)}]</span>` +
    `<span class="text"></span>`;
  node.querySelector(".text").textContent = msg.text;
  logEl.appendChild(node);
  logEl.scrollTop = logEl.scrollHeight;
}

window.api.onNewLine((msg) => upsertMessage(msg));
window.api.onClearLines(() => {
  logEl.innerHTML = "";
});
