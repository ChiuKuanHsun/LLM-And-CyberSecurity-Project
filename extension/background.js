/**
 * Service Worker — Manifest V3 背景腳本
 *
 * 為什麼需要 background：
 * 1. Content Script 受同源政策限制，跨域 fetch 不一定能成功。
 *    透過 message passing 把 fetch 委派給 Service Worker，
 *    讓 host_permissions 真正發揮作用。
 * 2. 集中管理 endpoint 設定（從 chrome.storage 讀取），
 *    Week 15 切換 Baseline / 本地 Ollama 時只需改這裡。
 * 3. 管理「使用者自訂掃描網站」：
 *    動態請求 host permission + 註冊 Content Script，
 *    讓使用者可在 Options 頁新增任意 webmail 頁面。
 */

const DEFAULT_ENDPOINT = "http://127.0.0.1:8080/analyze";

// ---------------- LLM Endpoint ----------------

async function getConfig() {
  const cfg = await chrome.storage.sync.get(["apiEndpoint", "engine"]);
  // API keys 從 storage.local 讀（不會同步到 Google 帳號）
  const keys = await chrome.storage.local.get(["geminiApiKey", "nvidiaApiKey"]);
  return {
    endpoint: cfg.apiEndpoint || DEFAULT_ENDPOINT,
    engine: cfg.engine || "ollama",   // 預設本地 Ollama，呼應「企業級本地防護」原則
    geminiKey: keys.geminiApiKey || "",
    nvidiaKey: keys.nvidiaApiKey || "",
  };
}

async function analyzeText({ text, source_url }) {
  const { endpoint, engine, geminiKey, nvidiaKey } = await getConfig();
  const t0 = performance.now();
  // 只在需要的引擎時帶 key header，避免無謂洩漏
  const headers = { "Content-Type": "application/json" };
  if (engine === "gemini" && geminiKey) headers["X-Gemini-Api-Key"] = geminiKey;
  if (engine === "nvidia" && nvidiaKey) headers["X-Nvidia-Api-Key"] = nvidiaKey;

  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify({ text, source_url, lang: "zh-TW", engine }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    data.client_latency_ms = Math.round(performance.now() - t0);
    return { ok: true, data };
  } catch (err) {
    console.error("[Phishing Detector] analyze failed:", err);
    return { ok: false, error: err.message };
  }
}

// ---------------- 自訂掃描網站管理 ----------------
/**
 * 使用者自訂網站清單儲存於 chrome.storage.sync.customSites
 * 結構：[{ pattern: "https://outlook.live.com/*", label: "Outlook Web", id: "site_xxx" }]
 *
 * 動態註冊流程：
 *   1. 前端 sendMessage("ADD_SITE", { pattern })
 *   2. 此處呼叫 chrome.permissions.request 觸發瀏覽器原生授權彈窗
 *   3. 使用者同意 → chrome.scripting.registerContentScripts 註冊
 *   4. 寫回 storage，下次 onStartup 時自動恢復
 */

const DYNAMIC_SCRIPT_PREFIX = "user_site_";

function normalizePattern(input) {
  let s = String(input || "").trim();
  if (!s) return null;
  // 使用者輸入完整 URL 時，取出 origin
  try {
    const u = new URL(s.includes("://") ? s : `https://${s}`);
    return `${u.protocol}//${u.hostname}/*`;
  } catch {
    return null;
  }
}

async function listCustomSites() {
  const { customSites = [] } = await chrome.storage.sync.get("customSites");
  return customSites;
}

async function saveCustomSites(sites) {
  await chrome.storage.sync.set({ customSites: sites });
}

async function addCustomSite({ pattern, label }) {
  const normalized = normalizePattern(pattern);
  if (!normalized) return { ok: false, error: "無效的網址格式" };

  const sites = await listCustomSites();
  if (sites.some(s => s.pattern === normalized)) {
    return { ok: false, error: "此網站已在清單中" };
  }

  // 動態請求 host permission（會跳出 Chrome 原生授權彈窗）
  let granted;
  try {
    granted = await chrome.permissions.request({ origins: [normalized] });
  } catch (e) {
    return { ok: false, error: `授權失敗：${e.message}` };
  }
  if (!granted) return { ok: false, error: "使用者拒絕授權" };

  const id = DYNAMIC_SCRIPT_PREFIX + Date.now().toString(36);
  try {
    await chrome.scripting.registerContentScripts([{
      id,
      matches: [normalized],
      js: ["content.js"],
      css: ["overlay.css"],
      runAt: "document_idle",
    }]);
  } catch (e) {
    // 註冊失敗時把已授權的 permission 退回
    await chrome.permissions.remove({ origins: [normalized] });
    return { ok: false, error: `註冊 Content Script 失敗：${e.message}` };
  }

  const newSite = { id, pattern: normalized, label: label?.trim() || normalized };
  sites.push(newSite);
  await saveCustomSites(sites);
  return { ok: true, site: newSite };
}

async function removeCustomSite({ id }) {
  const sites = await listCustomSites();
  const target = sites.find(s => s.id === id);
  if (!target) return { ok: false, error: "找不到此網站" };

  try {
    await chrome.scripting.unregisterContentScripts({ ids: [id] });
  } catch (e) {
    console.warn("unregister failed (可能本來就未註冊)", e);
  }
  try {
    await chrome.permissions.remove({ origins: [target.pattern] });
  } catch (e) {
    console.warn("permission remove failed", e);
  }
  await saveCustomSites(sites.filter(s => s.id !== id));
  return { ok: true };
}

/**
 * 啟動時用儲存的清單比對「實際已註冊」的動態腳本，
 * 把使用者上次新增過的網站重新註冊回來。
 * （Chrome 動態 Content Scripts 雖然官方說會持久化，但跨重啟時偶爾掉，
 *   採取「對齊 storage」策略最穩。）
 */
async function syncRegisteredScripts() {
  const sites = await listCustomSites();
  if (sites.length === 0) return;

  let existing = [];
  try {
    existing = await chrome.scripting.getRegisteredContentScripts();
  } catch (e) {
    console.warn("getRegisteredContentScripts failed", e);
  }
  const existingIds = new Set(existing.map(s => s.id));

  // 只有當前確實具備該 host permission 才能重新註冊
  const perms = await chrome.permissions.getAll();
  const grantedOrigins = new Set(perms.origins || []);

  const toRegister = sites
    .filter(s => !existingIds.has(s.id) && grantedOrigins.has(s.pattern))
    .map(s => ({
      id: s.id,
      matches: [s.pattern],
      js: ["content.js"],
      css: ["overlay.css"],
      runAt: "document_idle",
    }));

  if (toRegister.length) {
    try {
      await chrome.scripting.registerContentScripts(toRegister);
      console.log("[Phishing Detector] re-registered", toRegister.map(s => s.id));
    } catch (e) {
      console.error("re-register failed", e);
    }
  }
}

// ---------------- Message Router ----------------

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  switch (msg?.type) {
    case "ANALYZE_TEXT":
      analyzeText(msg.payload).then(sendResponse);
      return true;

    case "PING_BACKEND":
      getConfig()
        .then(({ endpoint }) => fetch(endpoint.replace("/analyze", "/health")))
        .then((r) => sendResponse({ ok: r.ok }))
        .catch((e) => sendResponse({ ok: false, error: e.message }));
      return true;

    case "LIST_SITES":
      listCustomSites().then((sites) => sendResponse({ ok: true, sites }));
      return true;

    case "ADD_SITE":
      addCustomSite(msg.payload).then(sendResponse);
      return true;

    case "REMOVE_SITE":
      removeCustomSite(msg.payload).then(sendResponse);
      return true;
  }
});

// ---------------- Lifecycle ----------------

chrome.runtime.onInstalled.addListener(() => {
  console.log("[Phishing Detector] installed, default endpoint =", DEFAULT_ENDPOINT);
  syncRegisteredScripts();
});

chrome.runtime.onStartup.addListener(() => {
  syncRegisteredScripts();
});
