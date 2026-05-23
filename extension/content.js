/**
 * Content Script — 注入到目標網頁，負責：
 *   1. 精準擷取信件 / 訊息純文本（過濾 HTML 雜訊與廣告）
 *   2. 將文本送給 Service Worker → FastAPI → LLM
 *   3. 根據風險等級注入警告 Overlay
 *
 * 報告章節對應：
 *   - 「DOM 擷取演算法」→ extractText()
 *   - 「Throttle / 重複分析避免」→ analyzedTexts Set + MutationObserver debounce
 */

(() => {
  "use strict";

  // 文本 hash → 分析結果。
  // 用 Map 而非 Set 是為了當 Gmail 重建 DOM 節點時，
  // 能直接「重播」既有結果重新渲染 Overlay，
  // 避免「關閉信件再開啟後警告消失」的 bug。
  const analyzedResults = new Map();
  let analyzeTimer = null;

  // ---------------------------------------------------------------
  // 1. DOM 擷取：依網站使用不同 selector，這是「精準度」的關鍵
  // ---------------------------------------------------------------
  const SITE_SELECTORS = {
    "mail.google.com": [
      "div.a3s.aiL",            // Gmail 信件本文容器
      "div[role='listitem'] .ii.gt",
    ],
    "facebook.com": [
      "div[role='article']",
      "div[data-ad-preview='message']",
    ],
    "line.me": [
      "div.mdMN02Msg",
      "div[class*='message']",
    ],
  };

  function pickSelectors() {
    const host = location.hostname;
    for (const key in SITE_SELECTORS) {
      if (host.includes(key)) return SITE_SELECTORS[key];
    }
    return null;
  }

  /**
   * 從元素中萃取乾淨文字：
   * - 移除 <script>, <style>, <noscript>
   * - 合併空白、剔除 emoji 過多的雜訊
   * - 限制長度避免 token 爆炸（後端也有 max_length=20000 防護）
   */
  function extractText(el) {
    if (!el) return "";
    const clone = el.cloneNode(true);
    clone.querySelectorAll("script, style, noscript, img, svg").forEach(n => n.remove());
    const text = clone.innerText || clone.textContent || "";
    return text.replace(/\s+/g, " ").trim().slice(0, 5000);
  }

  function hashString(s) {
    // 簡單 djb2 hash，僅用於去重，不需要密碼學強度
    let h = 5381;
    for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
    return h.toString(36);
  }

  // ---------------------------------------------------------------
  // 2. 掃描 + 送分析
  // ---------------------------------------------------------------
  async function scanAndAnalyze() {
    const selectors = pickSelectors();
    if (!selectors) return;

    const elements = [];
    for (const sel of selectors) {
      document.querySelectorAll(sel).forEach(el => elements.push(el));
    }

    for (const el of elements) {
      // 此 DOM 節點已渲染過 Overlay → 同一節點不重複渲染
      if (el.dataset.pdMarked === "1") continue;

      const text = extractText(el);
      if (text.length < 20) continue; // 太短，沒分析價值

      const key = hashString(text);

      // 命中前端快取：同樣文字內容（可能是不同 DOM 節點，如重新開啟的信件）
      // → 直接用快取結果重播 Overlay，不再送後端
      if (analyzedResults.has(key)) {
        handleResult(el, analyzedResults.get(key));
        continue;
      }

      try {
        const resp = await chrome.runtime.sendMessage({
          type: "ANALYZE_TEXT",
          payload: { text, source_url: location.href },
        });
        if (resp?.ok && resp.data) {
          analyzedResults.set(key, resp.data);
          handleResult(el, resp.data);
        }
      } catch (e) {
        console.warn("[Phishing Detector] send message failed:", e);
      }
    }
  }

  // ---------------------------------------------------------------
  // 3. 警告 Overlay 渲染
  // ---------------------------------------------------------------
  function handleResult(el, result) {
    if (!result.is_phishing) return;
    if (result.risk_level === "Low") return;
    if (el.dataset.pdMarked === "1") return;
    el.dataset.pdMarked = "1";

    const overlay = document.createElement("div");
    overlay.className = `pd-overlay pd-risk-${result.risk_level.toLowerCase()}`;
    overlay.innerHTML = `
      <div class="pd-banner">
        <span class="pd-icon">⚠️</span>
        <strong>偵測到可疑釣魚訊息 — 風險：${result.risk_level}</strong>
        <button class="pd-close" aria-label="關閉警告">✕</button>
      </div>
      <div class="pd-body">
        <p class="pd-explain">${escapeHtml(result.explanation)}</p>
        <p class="pd-intents">攻擊意圖：${result.detected_intents.join("、")}</p>
        <p class="pd-meta">後端延遲 ${result.latency_ms}ms · 引擎 ${escapeHtml(result.engine)}</p>
      </div>
    `;
    overlay.querySelector(".pd-close").addEventListener("click", () => overlay.remove());

    // 放在被偵測元素「之前」，不破壞原本網頁布局
    el.parentNode?.insertBefore(overlay, el);
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, m => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;",
    }[m]));
  }

  // ---------------------------------------------------------------
  // 4. 觀察 DOM 變化（Gmail 是 SPA，信件動態載入）
  // ---------------------------------------------------------------
  function scheduleScan() {
    clearTimeout(analyzeTimer);
    analyzeTimer = setTimeout(scanAndAnalyze, 500); // debounce 500ms
  }

  const observer = new MutationObserver(scheduleScan);
  observer.observe(document.body, { childList: true, subtree: true });

  // 頁面載入完先掃一次
  scheduleScan();

  console.log("[Phishing Detector] content script ready @", location.hostname);
})();
