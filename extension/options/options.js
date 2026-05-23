/**
 * Options Page — 設定頁邏輯
 *  1. BYOM 端點設定（雲端/本地切換）
 *  2. 自訂掃描網站清單（動態權限 + 動態 Content Script 註冊）
 */

const DEFAULTS = {
  apiEndpoint: "http://127.0.0.1:8080/analyze",
  mode: "local",
};

// ---------------- LLM Endpoint ----------------

async function loadEndpoint() {
  const cfg = await chrome.storage.sync.get(DEFAULTS);
  document.getElementById("endpoint").value = cfg.apiEndpoint;
  document.querySelector(`input[name="mode"][value="${cfg.mode}"]`).checked = true;
}

async function saveEndpoint() {
  const endpoint = document.getElementById("endpoint").value.trim() || DEFAULTS.apiEndpoint;
  const mode = document.querySelector('input[name="mode"]:checked').value;
  await chrome.storage.sync.set({ apiEndpoint: endpoint, mode });

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
  const resp = await chrome.runtime.sendMessage({ type: "LIST_SITES" });
  if (resp?.ok) renderSites(resp.sites);
}

async function addSite() {
  const input = document.getElementById("new-site");
  const labelInput = document.getElementById("new-label");
  const pattern = input.value.trim();
  if (!pattern) {
    alert("請輸入網址");
    return;
  }
  const btn = document.getElementById("add-site");
  btn.disabled = true;
  btn.textContent = "授權中…";

  const resp = await chrome.runtime.sendMessage({
    type: "ADD_SITE",
    payload: { pattern, label: labelInput.value },
  });

  btn.disabled = false;
  btn.textContent = "＋ 新增";

  if (resp?.ok) {
    input.value = "";
    labelInput.value = "";
    await loadSites();
  } else {
    alert(`新增失敗：${resp?.error || "未知錯誤"}`);
  }
}

async function removeSite(id, label) {
  if (!confirm(`確定要移除「${label}」？\n移除後該網站不會再被自動掃描。`)) return;
  const resp = await chrome.runtime.sendMessage({ type: "REMOVE_SITE", payload: { id } });
  if (resp?.ok) {
    await loadSites();
  } else {
    alert(`移除失敗：${resp?.error || "未知錯誤"}`);
  }
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
