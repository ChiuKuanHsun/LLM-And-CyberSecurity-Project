/**
 * Popup — 顯示連線狀態 + 一鍵將「當前網站」加入掃描清單
 *
 * 注意：chrome.permissions.request() 必須在 user gesture 內呼叫，
 * 因此「加入」按鈕的 click handler 內不可在 permissions.request 之前 await。
 */

const DEFAULT_ENDPOINT = "http://127.0.0.1:8080/analyze";
const DYNAMIC_SCRIPT_PREFIX = "user_site_";

// ---------------- 後端連線 ----------------

const ENGINE_LABELS = {
  ollama: "🟢 Ollama 本地",
  gemini: "☁️ Gemini",
  nvidia: "☁️ NVIDIA NIM",
  mock:   "🟡 Mock (離線)",
};

async function init() {
  const { apiEndpoint, engine = "ollama" } = await chrome.storage.sync.get(["apiEndpoint", "engine"]);
  const ep = apiEndpoint || DEFAULT_ENDPOINT;
  document.getElementById("endpoint").textContent = ep.replace("http://", "");
  document.getElementById("engine").textContent = ENGINE_LABELS[engine] || engine;
  await pingBackend();
  await loadCurrentSite();
}

async function pingBackend() {
  const statusEl = document.getElementById("status");
  statusEl.className = "status";
  statusEl.textContent = "檢查後端連線中…";
  const res = await chrome.runtime.sendMessage({ type: "PING_BACKEND" });
  if (res?.ok) {
    statusEl.className = "status ok";
    statusEl.textContent = "✅ 後端已連線";
  } else {
    statusEl.className = "status fail";
    statusEl.textContent = "❌ 無法連線：" + (res?.error || "請啟動 FastAPI");
  }
}

// ---------------- 當前網站偵測 ----------------

let currentTabUrl = null;
let currentPattern = null;

async function getCurrentTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

function patternFromUrl(url) {
  try {
    const u = new URL(url);
    if (!/^https?:$/.test(u.protocol)) return null; // 排除 chrome:// 等
    return `${u.protocol}//${u.hostname}/*`;
  } catch {
    return null;
  }
}

async function loadCurrentSite() {
  const tab = await getCurrentTab();
  currentTabUrl = tab?.url || null;
  currentPattern = patternFromUrl(currentTabUrl);

  const siteEl = document.getElementById("current-site");
  const statusEl = document.getElementById("current-status");
  const btn = document.getElementById("add-current");

  if (!currentPattern) {
    siteEl.textContent = "（無法在此頁面使用）";
    statusEl.innerHTML = '<span class="badge not-registered">不支援的頁面</span>';
    btn.hidden = true;
    return;
  }

  siteEl.textContent = currentPattern;

  const { customSites = [] } = await chrome.storage.sync.get("customSites");
  const builtIn = isBuiltInSupported(new URL(currentTabUrl).hostname);
  const userAdded = customSites.find(s => s.pattern === currentPattern);

  if (builtIn) {
    statusEl.innerHTML = '<span class="badge registered">✓ 內建支援，自動掃描中</span>';
    btn.hidden = true;
  } else if (userAdded) {
    statusEl.innerHTML = '<span class="badge registered">✓ 已加入掃描清單</span>';
    btn.hidden = true;
  } else {
    statusEl.innerHTML = '<span class="badge not-registered">尚未加入掃描清單</span>';
    btn.hidden = false;
  }
}

function isBuiltInSupported(host) {
  // 對應 manifest.json 內 content_scripts.matches 的網域
  return host.includes("mail.google.com")
      || host.includes("facebook.com")
      || host.includes("line.me");
}

// ---------------- 一鍵加入（核心：user gesture 內請求權限） ----------------

async function addCurrentSite() {
  if (!currentPattern) return;
  const btn = document.getElementById("add-current");
  btn.disabled = true;
  btn.textContent = "授權中…";

  try {
    // ★ 直接同步呼叫 permissions.request，保留 user gesture
    const granted = await chrome.permissions.request({ origins: [currentPattern] });
    if (!granted) {
      alert("使用者拒絕授權");
      return;
    }

    const { customSites = [] } = await chrome.storage.sync.get("customSites");
    if (customSites.some(s => s.pattern === currentPattern)) {
      await loadCurrentSite();
      return;
    }

    const id = DYNAMIC_SCRIPT_PREFIX + Date.now().toString(36);
    try {
      await chrome.scripting.registerContentScripts([{
        id,
        matches: [currentPattern],
        js: ["content.js"],
        css: ["overlay.css"],
        runAt: "document_idle",
      }]);
    } catch (e) {
      await chrome.permissions.remove({ origins: [currentPattern] });
      alert(`註冊 Content Script 失敗：${e.message}`);
      return;
    }

    customSites.push({
      id,
      pattern: currentPattern,
      label: new URL(currentTabUrl).hostname,
    });
    await chrome.storage.sync.set({ customSites });

    // 通知使用者並提示要重新整理分頁才會即時生效
    if (confirm("✅ 加入成功！\n\n要立即重新整理目前分頁來啟用掃描嗎？")) {
      const tab = await getCurrentTab();
      if (tab?.id) chrome.tabs.reload(tab.id);
    }
    await loadCurrentSite();
  } catch (e) {
    alert(`新增失敗：${e.message}`);
  } finally {
    btn.disabled = false;
    btn.textContent = "＋ 將此網站加入掃描清單";
  }
}

// ---------------- 綁定 ----------------

document.getElementById("ping").addEventListener("click", pingBackend);
document.getElementById("open-options").addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
});
document.getElementById("add-current").addEventListener("click", addCurrentSite);

init();
