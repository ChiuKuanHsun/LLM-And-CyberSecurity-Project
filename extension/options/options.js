/**
 * Options Page — 設定頁邏輯
 *  1. BYOM 端點設定（雲端/本地切換）
 *  2. 自訂掃描網站清單（動態權限 + 動態 Content Script 註冊）
 *
 * 注意：chrome.permissions.request() 必須在 user gesture 同步呼叫，
 * 不能透過 sendMessage 走到 Service Worker 再請求，否則會拋
 * "This function must be called during a user gesture"。
 * 因此「新增網站」流程完全在本檔內處理，不轉發到 background.js。
 */

const DEFAULTS = {
  apiEndpoint: "http://127.0.0.1:8080/analyze",
  engine: "ollama",   // 預設本地，呼應「企業級本地防護」原則
};

const DYNAMIC_SCRIPT_PREFIX = "user_site_";

function normalizePattern(input) {
  let s = String(input || "").trim();
  if (!s) return null;
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

// ---------------- LLM Endpoint ----------------

async function loadEndpoint() {
  const cfg = await chrome.storage.sync.get(DEFAULTS);
  document.getElementById("endpoint").value = cfg.apiEndpoint;
  const radio = document.querySelector(`input[name="engine"][value="${cfg.engine}"]`);
  if (radio) radio.checked = true;
}

async function saveEndpoint() {
  const endpoint = document.getElementById("endpoint").value.trim() || DEFAULTS.apiEndpoint;
  const engine = document.querySelector('input[name="engine"]:checked')?.value || DEFAULTS.engine;
  await chrome.storage.sync.set({ apiEndpoint: endpoint, engine });

  const msg = document.getElementById("saved-msg");
  msg.hidden = false;
  setTimeout(() => (msg.hidden = true), 1500);
}

async function testEndpoint() {
  const endpoint = document.getElementById("endpoint").value.trim() || DEFAULTS.apiEndpoint;
  const healthUrl = endpoint.replace("/analyze", "/health");
  try {
    const r = await fetch(healthUrl);
    alert(r.ok ? `✅ 連線成功：${healthUrl}` : `❌ HTTP ${r.status}`);
  } catch (e) {
    alert(`❌ 無法連線：${e.message}\n\n請確認 FastAPI 已啟動：\nuvicorn main:app --reload`);
  }
}

// ---------------- 自訂掃描網站 ----------------

function renderSites(sites) {
  const list = document.getElementById("site-list");
  if (!sites || sites.length === 0) {
    list.innerHTML = '<li class="empty">尚未新增任何自訂網站。</li>';
    return;
  }
  list.innerHTML = "";
  for (const s of sites) {
    const li = document.createElement("li");
    li.innerHTML = `
      <span class="site-pattern"></span>
      <span class="site-label"></span>
      <button class="remove-btn" data-id="">移除</button>
    `;
    li.querySelector(".site-pattern").textContent = s.pattern;
    li.querySelector(".site-label").textContent = s.label === s.pattern ? "" : s.label;
    const btn = li.querySelector(".remove-btn");
    btn.dataset.id = s.id;
    btn.addEventListener("click", () => removeSite(s.id, s.label || s.pattern));
    list.appendChild(li);
  }
}

async function loadSites() {
  const sites = await listCustomSites();
  renderSites(sites);
}

/**
 * 直接在 user gesture 內請求權限，不轉發到 background。
 * 注意：本函式必須由 click event handler 「同步」呼叫到 chrome.permissions.request()
 * 之前，不能在這之前 await 任何非同步 chrome.* API，否則會丟失 user gesture context。
 */
async function addSite() {
  const input = document.getElementById("new-site");
  const labelInput = document.getElementById("new-label");
  const pattern = input.value.trim();
  if (!pattern) {
    alert("請輸入網址");
    return;
  }
  const normalized = normalizePattern(pattern);
  if (!normalized) {
    alert("無效的網址格式");
    return;
  }

  const btn = document.getElementById("add-site");
  btn.disabled = true;
  btn.textContent = "授權中…";

  try {
    // ★ 關鍵：permissions.request 必須在 user gesture 內呼叫
    const granted = await chrome.permissions.request({ origins: [normalized] });
    if (!granted) {
      alert("使用者拒絕授權");
      return;
    }

    // user gesture 已不重要，後面可隨意 await
    const sites = await listCustomSites();
    if (sites.some(s => s.pattern === normalized)) {
      alert("此網站已在清單中");
      return;
    }

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
      // 註冊失敗就把剛才授權的權限退回，避免殘留
      await chrome.permissions.remove({ origins: [normalized] });
      alert(`註冊 Content Script 失敗：${e.message}`);
      return;
    }

    sites.push({ id, pattern: normalized, label: labelInput.value.trim() || normalized });
    await saveCustomSites(sites);
    input.value = "";
    labelInput.value = "";
    await loadSites();
  } catch (e) {
    alert(`新增失敗：${e.message}`);
  } finally {
    btn.disabled = false;
    btn.textContent = "＋ 新增";
  }
}

async function removeSite(id, label) {
  if (!confirm(`確定要移除「${label}」？\n移除後該網站不會再被自動掃描。`)) return;
  const sites = await listCustomSites();
  const target = sites.find(s => s.id === id);
  if (!target) {
    alert("找不到此網站");
    return;
  }
  try {
    await chrome.scripting.unregisterContentScripts({ ids: [id] });
  } catch (e) {
    console.warn("unregister failed:", e);
  }
  try {
    await chrome.permissions.remove({ origins: [target.pattern] });
  } catch (e) {
    console.warn("permission remove failed:", e);
  }
  await saveCustomSites(sites.filter(s => s.id !== id));
  await loadSites();
}

// ---------------- 綁定 ----------------

document.getElementById("save").addEventListener("click", saveEndpoint);
document.getElementById("test").addEventListener("click", testEndpoint);
document.getElementById("add-site").addEventListener("click", addSite);
document.getElementById("new-site").addEventListener("keydown", (e) => {
  if (e.key === "Enter") addSite();
});

loadEndpoint();
loadSites();
