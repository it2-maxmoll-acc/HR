"use strict";

const { app, BrowserWindow, ipcMain, dialog, session, safeStorage, clipboard, net: electronNet } = require("electron");
const path = require("path");
const fs = require("fs");
const os = require("os");
const nodeNet = require("net");

const isDev = !app.isPackaged;
const PROXY_PROBE_URL = "https://api.openai.com/v1/models";

let overlayWin = null;
let mainWin = null;
let proxyAuth = null;
// Raw proxy config kept in memory so the runtime toggle can re-apply it.
let _lastRawProxyConfig = null;
// Tracks whether proxy is currently active (false = DIRECT mode in use).
let _proxyRuntimeEnabled = false;
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
  openAiProbe: null,
  directProbe: null,
  directFallbackApplied: false,
  runtimeEnabled: false,
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
    const socket = nodeNet.connect({ host, port, timeout: PROXY_SOCKET_TIMEOUT_MS });
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

function probeOpenAiThroughSession(sess) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const request = electronNet.request({
      session: sess,
      method: "HEAD",
      url: PROXY_PROBE_URL,
    });
    let settled = false;
    const finish = (success, detail, statusCode) => {
      if (settled) return;
      settled = true;
      resolve({
        success,
        detail: detail || null,
        statusCode: statusCode || null,
        durationMs: Date.now() - startedAt,
      });
    };

    const timeout = setTimeout(() => {
      try {
        request.abort();
      } catch {}
      finish(false, `timeout after ${PROXY_SOCKET_TIMEOUT_MS}ms`, null);
    }, PROXY_SOCKET_TIMEOUT_MS);

    // For HTTP proxies: supply credentials when Chromium raises a 407 challenge
    // on the probe request itself. (SOCKS5 auth is handled via embedded credentials
    // in proxyRules, so this handler fires only for HTTP/HTTPS proxy challenges.)
    request.on("login", (authInfo, callback) => {
      const info = `scheme=${authInfo?.scheme} host=${authInfo?.host}:${authInfo?.port} isProxy=${authInfo?.isProxy}`;
      console.log(`[proxy] probe login event: ${info} hasCredentials=${Boolean(proxyAuth?.username)}`);
      if (authInfo?.isProxy && proxyAuth?.username) {
        callback(proxyAuth.username, proxyAuth.password || "");
      } else {
        callback("", "");
      }
    });

    request.on("response", (res) => {
      clearTimeout(timeout);
      const detail = `HTTP ${res.statusCode}`;
      console.log(`[proxy] probe response: ${detail} durationMs=${Date.now() - startedAt}`);
      finish(true, detail, res.statusCode);
    });
    request.on("error", (err) => {
      clearTimeout(timeout);
      const detail = err?.message || String(err);
      console.log(`[proxy] probe error: ${detail} durationMs=${Date.now() - startedAt}`);
      finish(false, detail, null);
    });
    request.end();
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
    protocol: null,
    proxyRules: null,
    proxyBypassRules: null,
    rawSocketTest: null,
    openAiProbe: null,
    directProbe: null,
    directFallbackApplied: false,
  };

  if (!cfg) {
    proxyDiagnostics.warnings.push("No valid proxy config JSON found.");
    console.warn("[proxy] No valid proxy config JSON found in candidate paths.");
    return;
  }

  console.log(
    `[proxy] Config selected: ${loaded.selectedPath || "<none>"} enabled=${Boolean(cfg.enabled)}`,
  );

  const protocol = String(cfg.protocol || "http").toLowerCase();
  const host = String(cfg.host || "").trim();
  const port = Number(cfg.port);
  if (!host || !Number.isFinite(port) || port <= 0) {
    proxyDiagnostics.error = "Invalid proxy host/port in selected config.";
    return;
  }

  // Keep the full config (including credentials) so the runtime toggle can
  // re-apply it without re-reading from disk — even if currently disabled.
  _lastRawProxyConfig = cfg;

  if (!cfg.enabled) {
    proxyDiagnostics.warnings.push(
      `Selected proxy config is disabled (${loaded.selectedPath || "<unknown>"}).`,
    );
    return;
  }

  // Credential embedding rules per proxy protocol:
  //
  // SOCKS5/SOCKS4: Chromium supports credentials embedded directly in the URL as
  //   ******host:port. The app.on('login') event does NOT fire for
  //   SOCKS5 protocol-level auth handshakes, so credentials MUST be in the URL.
  //
  // HTTP/HTTPS: Chromium does NOT support credentials in the proxy URL — embedding
  //   them causes net::ERR_NO_SUPPORTED_PROXIES. HTTP proxy auth must use the
  //   app.on('login') 407 challenge handler below.
  const username = String(cfg.username || "").trim();
  const password = String(cfg.password || "");
  const isSocks = protocol.startsWith("socks");
  const proxyRulesForDiagnostics = `${protocol}://${host}:${port}`;
  const proxyRules = (isSocks && username)
    ? `${protocol}://${encodeURIComponent(username)}:${encodeURIComponent(password)}@${host}:${port}`
    : `${protocol}://${host}:${port}`;
  if (isSocks && username) {
    console.log(`[proxy] SOCKS5 credentials embedded in proxyRules (user=${username})`);
  }
  const proxyBypassRules =
    Array.isArray(cfg.bypass) && cfg.bypass.length > 0
      ? cfg.bypass.map((x) => String(x).trim()).filter(Boolean).join(";")
      : "<local>";

  // Keep proxyAuth for the login event handler (both HTTP 407 and SOCKS5 auth).
  proxyAuth = username ? { username, password } : null;
  proxyDiagnostics.authConfigured = Boolean(proxyAuth);

  proxyDiagnostics.applyAttempted = true;
  await sess.setProxy({
    proxyRules,
    proxyBypassRules,
  });
  proxyDiagnostics.applySucceeded = true;
  proxyDiagnostics.protocol = protocol;
  proxyDiagnostics.proxyRules = proxyRulesForDiagnostics;
  proxyDiagnostics.proxyBypassRules = proxyBypassRules;
  console.log(
    `[proxy] Applied proxyRules=${proxyRulesForDiagnostics} proxyBypassRules=${proxyBypassRules}`,
  );

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
        `Resolved route for ${PROXY_PROBE_URL} is DIRECT (${proxyDiagnostics.resolvedProxy}) even though ` +
          `proxyRules=${proxyRulesForDiagnostics} proxyBypassRules=${proxyBypassRules} were applied. ` +
          `Check that the host is not matched by proxyBypassRules and that setProxy() was not overridden later.`,
      );
    }
  } catch (e) {
    proxyDiagnostics.warnings.push(
      `Could not resolve proxy route: ${e?.message || String(e)}`,
    );
  }

  proxyDiagnostics.openAiProbe = await probeOpenAiThroughSession(sess);
  if (!proxyDiagnostics.openAiProbe.success) {
    const detail = String(proxyDiagnostics.openAiProbe.detail || "");
    const normalized = detail.toUpperCase();
    proxyDiagnostics.warnings.push(
      `OpenAI route probe failed via current proxy route: ${detail || "<unknown>"}.`,
    );
    console.error(`[proxy] OpenAI route probe failed: ${detail || "<unknown>"}`);

    const isProxyIncompatible =
      normalized.includes("ERR_NO_SUPPORTED_PROXIES")
      || normalized.includes("ERR_PROXY")
      || normalized.includes("ERR_TUNNEL_CONNECTION_FAILED")
      || normalized.includes("ERR_SOCKS_CONNECTION_FAILED");

    // Step 1: If socks5 gives ERR_NO_SUPPORTED_PROXIES, auto-retry with socks5h://
    // (socks5h delegates hostname resolution to the proxy server, which avoids
    // ERR_NO_SUPPORTED_PROXIES that Chromium can raise for socks5:// in some
    // configurations — e.g. when the proxy requires auth or has DNS restrictions).
    let resolvedViaAltProtocol = false;
    if (normalized.includes("ERR_NO_SUPPORTED_PROXIES") && protocol === "socks5") {
      const socks5hRules = (isSocks && username)
        ? `socks5h://${encodeURIComponent(username)}:${encodeURIComponent(password)}@${host}:${port}`
        : `socks5h://${host}:${port}`;
      console.warn(
        "[proxy] ERR_NO_SUPPORTED_PROXIES via socks5:// — retrying with socks5h:// (remote DNS). " +
          "Tip: set \"protocol\": \"socks5h\" in your proxy config to avoid this retry at startup.",
      );
      await sess.setProxy({ proxyRules: socks5hRules, proxyBypassRules });
      const socks5hProbe = await probeOpenAiThroughSession(sess);
      console.log(
        `[proxy] socks5h probe: success=${socks5hProbe.success} durationMs=${socks5hProbe.durationMs} detail=${socks5hProbe.detail || "<none>"}`,
      );
      if (socks5hProbe.success) {
        proxyDiagnostics.proxyRules = `socks5h://${host}:${port}`;
        proxyDiagnostics.protocol = "socks5h";
        proxyDiagnostics.openAiProbe = socks5hProbe;
        resolvedViaAltProtocol = true;
        proxyDiagnostics.warnings.push(
          "socks5:// gave ERR_NO_SUPPORTED_PROXIES; switched to socks5h:// (remote DNS) automatically. " +
            "Set \"protocol\": \"socks5h\" in proxy config to avoid this retry at startup.",
        );
        console.warn("[proxy] socks5h:// probe succeeded — using socks5h for remote DNS resolution.");
      } else {
        // socks5h also failed — restore original rules and fall through to DIRECT logic
        await sess.setProxy({ proxyRules, proxyBypassRules });
        proxyDiagnostics.warnings.push(
          `socks5h:// retry also failed (${socks5hProbe.detail || "<unknown>"}). ` +
            "Verify that the SOCKS5 proxy is accessible and that credentials (username/password) " +
            "are correct in proxy config. Try protocol=socks5h explicitly if the proxy needs remote DNS.",
        );
        console.warn(`[proxy] socks5h:// also failed: ${socks5hProbe.detail || "<unknown>"}`);
      }
    }

    // Step 2: If proxy route is invalid/unusable inside Chromium, try DIRECT.
    // With autoDirectFallback=true the app switches to DIRECT even when the
    // direct probe returns HTTP 403 (geo-blocked) — this is useful when the
    // user has a system-level VPN active that bypasses geo-restrictions but the
    // probe ran before the VPN was established (or Chromium probed before VPN
    // routing kicked in).
    if (!resolvedViaAltProtocol && isProxyIncompatible) {
      await sess.setProxy({ mode: "direct" });
      proxyDiagnostics.directProbe = await probeOpenAiThroughSession(sess);
      const directOk = proxyDiagnostics.directProbe.success
        && proxyDiagnostics.directProbe.statusCode !== 403;
      const autoFallback = Boolean(cfg.autoDirectFallback);

      if (directOk || autoFallback) {
        proxyDiagnostics.directFallbackApplied = true;
        if (autoFallback && !directOk) {
          proxyDiagnostics.warnings.push(
            "Proxy route failed; DIRECT probe returned " +
              `${proxyDiagnostics.directProbe.detail || "<unknown>"}. ` +
              "Switching to DIRECT mode (autoDirectFallback=true) — " +
              "VPN will provide geo-bypass at request time.",
          );
          console.warn(
            "[proxy] autoDirectFallback: keeping DIRECT despite probe result — VPN expected to route traffic.",
          );
        } else {
          proxyDiagnostics.warnings.push(
            "Proxy route failed in Chromium; applied DIRECT fallback automatically.",
          );
          console.warn("[proxy] Applied DIRECT fallback after proxy probe failure.");
        }
        try {
          proxyDiagnostics.resolvedProxy = await sess.resolveProxy(PROXY_PROBE_URL);
        } catch {}
      } else {
        const directReason = proxyDiagnostics.directProbe.statusCode === 403
          ? "geo-blocked (HTTP 403 Country not supported)"
          : (proxyDiagnostics.directProbe.detail || "<unknown>");
        await sess.setProxy({
          proxyRules,
          proxyBypassRules,
        });
        proxyDiagnostics.warnings.push(
          `DIRECT fallback not usable (${directReason}); keeping configured proxy route. ` +
            "If you have a system VPN, enable \"Авто (VPN)\" in the app or set " +
            "\"autoDirectFallback\": true in proxy config.",
        );
        console.warn(`[proxy] DIRECT fallback not usable (${directReason}); restored configured proxy route.`);
        try {
          proxyDiagnostics.resolvedProxy = await sess.resolveProxy(PROXY_PROBE_URL);
        } catch {}
      }
    }
  }

  // Update runtime state: proxy is active unless a DIRECT fallback was applied.
  _proxyRuntimeEnabled = !proxyDiagnostics.directFallbackApplied;
  proxyDiagnostics.runtimeEnabled = _proxyRuntimeEnabled;
}


function _persistProxyEnabled(enabled) {
  try {
    const userDataConfigPath = path.join(app.getPath("userData"), "proxy.config.json");
    if (!fs.existsSync(userDataConfigPath)) return;
    const raw = readJsonIfExists(userDataConfigPath);
    if (!raw || typeof raw !== "object") return;
    raw.enabled = enabled;
    fs.writeFileSync(userDataConfigPath, JSON.stringify(raw, null, 2), "utf8");
  } catch (e) {
    console.warn(`[proxy] Could not persist enabled flag: ${e?.message || String(e)}`);
  }
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
    autoDirectFallback: Boolean(cfg.autoDirectFallback),
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
  // Forward it to the renderer too, so it shows up in the in-app "Системные логи"
  // panel — previously this only went to the (invisible, in a packaged app) main
  // process console, leaving the real cause of network failures undiagnosable.
  session.defaultSession.webRequest.onErrorOccurred((details) => {
    let hostname = "";
    try {
      hostname = new URL(details?.url || "").hostname;
    } catch {
      return;
    }
    if (hostname !== "api.openai.com") return;
    const msg = `[proxy] Network error for ${details.url}: ${details.error} (resourceType=${details.resourceType})`;
    console.error(msg);
    if (mainWin && !mainWin.isDestroyed()) {
      mainWin.webContents.send("net-error", msg);
    }
  });

  // Allow the renderer to request microphone and desktop audio without extra prompts.
  session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => {
    if (permission === "media" || permission === "clipboard-read" || permission === "clipboard-sanitized-write") {
      return cb(true);
    }
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
  const scheme = authInfo?.scheme || "<none>";
  const host = authInfo?.host || "<none>";
  const port = authInfo?.port || "<none>";
  const isProxy = Boolean(authInfo?.isProxy);
  const hasCredentials = Boolean(proxyAuth?.username);
  const loginMsg = `[proxy] login event: isProxy=${isProxy} scheme=${scheme} host=${host}:${port} hasCredentials=${hasCredentials}`;
  console.log(loginMsg);
  if (mainWin && !mainWin.isDestroyed()) {
    mainWin.webContents.send("net-error", loginMsg);
  }
  if (!isProxy || !hasCredentials) return;
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

ipcMain.handle("copy-to-clipboard", (_evt, text) => {
  try {
    clipboard.writeText(String(text ?? ""));
    return { success: true };
  } catch (err) {
    return { success: false, error: err?.message || String(err) };
  }
});

ipcMain.handle("get-proxy-diagnostics", () => ({
  ...proxyDiagnostics,
  candidatePaths: proxyDiagnostics.candidates?.map((x) => x.path) || [],
}));

ipcMain.handle("toggle-proxy", async (_evt, enable) => {
  const sess = session.defaultSession;

  if (!enable) {
    // Turn OFF: switch to DIRECT mode.
    await sess.setProxy({ mode: "direct" });
    proxyAuth = null;
    _proxyRuntimeEnabled = false;
    proxyDiagnostics.runtimeEnabled = false;
    proxyDiagnostics.authConfigured = false;
    try {
      proxyDiagnostics.resolvedProxy = await sess.resolveProxy(PROXY_PROBE_URL);
    } catch {}
    _persistProxyEnabled(false);
    console.log("[proxy] Toggled OFF by user (direct mode).");
    return { ok: true, runtimeEnabled: false };
  }

  // Turn ON: re-apply proxy from the last loaded config.
  if (!_lastRawProxyConfig) {
    return { ok: false, runtimeEnabled: false, error: "No proxy config available. Check proxy.config.json." };
  }

  const cfg = _lastRawProxyConfig;
  const protocol = String(cfg.protocol || "http").toLowerCase();
  const host = String(cfg.host || "").trim();
  const port = Number(cfg.port);
  if (!host || !Number.isFinite(port) || port <= 0) {
    return { ok: false, runtimeEnabled: false, error: "Invalid proxy host/port in config." };
  }

  const username = String(cfg.username || "").trim();
  const password = String(cfg.password || "");
  const isSocks = protocol.startsWith("socks");
  const proxyRulesForDisplay = `${protocol}://${host}:${port}`;
  const proxyRules = (isSocks && username)
    ? `${protocol}://${encodeURIComponent(username)}:${encodeURIComponent(password)}@${host}:${port}`
    : `${protocol}://${host}:${port}`;
  const proxyBypassRules =
    Array.isArray(cfg.bypass) && cfg.bypass.length > 0
      ? cfg.bypass.map((x) => String(x).trim()).filter(Boolean).join(";")
      : "<local>";

  proxyAuth = username ? { username, password } : null;
  proxyDiagnostics.authConfigured = Boolean(proxyAuth);
  proxyDiagnostics.proxyRules = proxyRulesForDisplay;
  proxyDiagnostics.proxyBypassRules = proxyBypassRules;
  proxyDiagnostics.protocol = protocol;

  if (isSocks && username) {
    console.log(`[proxy] SOCKS5 credentials embedded in proxyRules (user=${username})`);
  }
  await sess.setProxy({ proxyRules, proxyBypassRules });
  _proxyRuntimeEnabled = true;
  proxyDiagnostics.runtimeEnabled = true;
  proxyDiagnostics.directFallbackApplied = false;

  try {
    proxyDiagnostics.resolvedProxy = await sess.resolveProxy(PROXY_PROBE_URL);
  } catch {}

  _persistProxyEnabled(true);
  console.log(`[proxy] Toggled ON by user: ${proxyRulesForDisplay}`);
  return { ok: true, runtimeEnabled: true };
});

// Update individual fields in the on-disk proxy config (e.g. autoDirectFallback).
// Also syncs _lastRawProxyConfig so the runtime toggle reflects the change.
ipcMain.handle("update-proxy-config", (_evt, updates) => {
  try {
    const userDataConfigPath = path.join(app.getPath("userData"), "proxy.config.json");
    if (!fs.existsSync(userDataConfigPath)) {
      return { ok: false, error: "Proxy config file not found at " + userDataConfigPath };
    }
    const raw = readJsonIfExists(userDataConfigPath);
    if (!raw || typeof raw !== "object") {
      return { ok: false, error: "Invalid proxy config JSON." };
    }
    const allowed = ["autoDirectFallback", "enabled", "protocol"];
    for (const [key, value] of Object.entries(updates || {})) {
      if (allowed.includes(key)) raw[key] = value;
    }
    fs.writeFileSync(userDataConfigPath, JSON.stringify(raw, null, 2), "utf8");
    if (_lastRawProxyConfig) {
      for (const [key, value] of Object.entries(updates || {})) {
        if (allowed.includes(key)) _lastRawProxyConfig[key] = value;
      }
    }
    // Refresh the sanitized snapshot in diagnostics so the renderer gets the new value.
    proxyDiagnostics.selectedConfig = sanitizeProxyConfig(_lastRawProxyConfig);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }
});

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
    return { encrypted: false };
  }
  if (safeStorage.isEncryptionAvailable()) {
    fs.writeFileSync(fp, safeStorage.encryptString(key));
    return { encrypted: true };
  } else {
    console.warn("[apikey] safeStorage encryption unavailable — API key will be stored in plaintext.");
    fs.writeFileSync(fp, key, "utf8");
    return { encrypted: false };
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
