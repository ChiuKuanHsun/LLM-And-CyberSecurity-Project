/**
 * Popup — 顯示後端連線狀態、提供快速設定入口
 */

const DEFAULT_ENDPOINT = "http://127.0.0.1:8080/analyze";

async function init() {
  const { apiEndpoint } = await chrome.storage.sync.get("apiEndpoint");
  const ep = apiEndpoint || DEFAULT_ENDPOINT;
  document.getElementById("endpoint").textContent = ep.replace("http://", "");
  await pingBackend();
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

document.getElementById("ping").addEventListener("click", pingBackend);
document.getElementById("open-options").addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
});

init();
