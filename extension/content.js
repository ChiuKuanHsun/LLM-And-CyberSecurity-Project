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
  // 正在送後端分析中的 text hash —— 防止 MutationObserver
  // 因為我們插入 loading overlay 而觸發新一輪 scan，
  // 在第一次 await 還沒結束時就再插一個 loading（分身 bug）。
  const inFlightHashes = new Set();
  let analyzeTimer = null;

  // ---------------------------------------------------------------
  // 1. DOM 擷取：依網站使用不同 selector，這是「精準度」的關鍵
  // ---------------------------------------------------------------
  const SITE_SELECTORS = {
    "mail.google.com": [
      "div.a3s.aiL",            // Gmail 信件本文容器
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

  // 未知網站的 fallback：通用語意標籤 + 常見 webmail/社群模式
  // 設計理念：寧可多抓再用 looksLikeContent 過濾，也不要漏抓
  const FALLBACK_SELECTORS = [
    "article",
    "main",
    "[role='article']",
    "[role='main']",
    "[role='listitem']",
    "[class*='message-body']",
    "[class*='email-body']",
    "[class*='mail-body']",
    "[class*='msg-body']",
    "[class*='post-content']",
    "[id*='msg-']",
  ];

  function pickSelectors() {
    const host = location.hostname;
    for (const key in SITE_SELECTORS) {
      if (host.includes(key)) return { selectors: SITE_SELECTORS[key], useHeuristic: false };
    }
    return { selectors: FALLBACK_SELECTORS, useHeuristic: true };
  }

  /**
   * 內容密度啟發式：判斷一個元素是否「像」訊息／信件內容，
   * 而不是導覽列、廣告、版權標。
   *  1. 長度 >= 30 字（過濾按鈕、標題列）
   *  2. 連結文字佔比 < 70%（過濾選單列）
   *  3. 不在明顯雜訊容器內（footer/nav/aside/header）
   */
  function looksLikeContent(el) {
    if (!el) return false;
    if (el.closest("nav, header, footer, aside")) return false;
    const text = (el.innerText || "").trim();
    if (text.length < 30) return false;
    const linkText = Array.from(el.querySelectorAll("a"))
      .map(a => (a.innerText || "")).join("").length;
    if (linkText / text.length > 0.7) return false;
    return true;
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
    // 連同我們自己注入的 .pd-overlay 一起剔除，
    // 否則對外層容器二次掃描時會把警告文字也算進 hash，造成重複渲染。
    clone.querySelectorAll("script, style, noscript, img, svg, .pd-overlay").forEach(n => n.remove());
    const text = clone.innerText || clone.textContent || "";
    return text.replace(/\s+/g, " ").trim().slice(0, 5000);
  }

  function hashString(s) {
    // 簡單 djb2 hash，僅用於去重，不需要密碼學強度
    let h = 5381;
    for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
    return h.toString(36);
  }

  /**
   * 前端粗篩：在送後端前先過濾掉明顯不需要分析的內容，
   * 節省每次 5-6 秒的 LLM 推理成本。
   *
   * 過濾規則（依誤判率由低到高）：
   *  1. 文本太短（< 20 字）
   *  2. 純 ASCII / 英數標點（多半是 URL、ID、英文 UI 字串）
   *     —— 本系統設計針對繁中釣魚，含中文才有意義
   *  3. 元素隱形（display:none / visibility:hidden / 0×0 尺寸）
   *  4. 連結文字佔比 > 70%（明顯選單列；已於 fallback 走過一次，這裡再保險）
   */
  function shouldSkip(el, text) {
    if (text.length < 20) return "too_short";

    // 純 ASCII 且無中文 → 多為 URL / ID / 英文 nav
    if (!/[一-鿿]/.test(text)) return "no_cjk";

    // 元素隱形（getBoundingClientRect 0 或 display:none）
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return "invisible";

    // 連結密度（雖然 fallback 已過濾，這裡對主站也加一層保險）
    const linkText = Array.from(el.querySelectorAll("a"))
      .map(a => (a.innerText || "")).join("").length;
    if (text.length > 0 && linkText / text.length > 0.7) return "link_heavy";

    return null;
  }

  // ---------------------------------------------------------------
  // 2. 掃描 + 送分析
  // ---------------------------------------------------------------
  async function scanAndAnalyze() {
    const { selectors, useHeuristic } = pickSelectors();
    if (!selectors) return;

    const elements = [];
    for (const sel of selectors) {
      try {
        document.querySelectorAll(sel).forEach(el => elements.push(el));
      } catch (e) {
        console.warn("[Phishing Detector] invalid selector:", sel, e);
      }
    }
    // 未知網站走 fallback：再用啟發式過一次，避免抓到一堆雜訊
    const filtered = useHeuristic ? elements.filter(looksLikeContent) : elements;

    // 同一次掃描內的文本去重：避免多個 selector 撈到「同一封信件的不同層級節點」
    // 而導致同封郵件出現兩個 Overlay。
    const seenInThisScan = new Set();

    for (const el of filtered) {
      // 此 DOM 節點已渲染過 Overlay → 同一節點不重複渲染
      if (el.dataset.pdMarked === "1") continue;
      // 任一祖先已標記過 → 該封信件已由內層子節點處理，跳過外層
      if (el.parentElement?.closest('[data-pd-marked="1"]')) continue;
      // 任一後代已標記過 → 該封信件已由內層子節點處理，跳過外層
      if (el.querySelector('[data-pd-marked="1"]')) continue;

      const text = extractText(el);

      // 前端粗篩：先濾掉明顯不需分析的內容
      const skipReason = shouldSkip(el, text);
      if (skipReason) {
        // 不印 log，避免 console 暴衝；報告中只需引用 §粗篩規則
        continue;
      }

      const key = hashString(text);

      // 同次掃描已處理過此文本 → 跳過（不同 selector 撈到同信件）
      if (seenInThisScan.has(key)) continue;
      seenInThisScan.add(key);

      // 命中前端快取：同樣文字內容（可能是不同 DOM 節點，如重新開啟的信件）
      // → 直接用快取結果重播 Overlay，不再送後端
      if (analyzedResults.has(key)) {
        handleResult(el, analyzedResults.get(key));
        continue;
      }

      // 此文本已在 in-flight：MutationObserver 因我們插入 loading 而觸發
      // 重掃時不要再送一次後端、也不要再插 loading（分身 bug）
      if (inFlightHashes.has(key)) continue;
      if (el.dataset.pdInFlight === "1") continue;

      inFlightHashes.add(key);
      el.dataset.pdInFlight = "1";

      // 立即注入 loading 骨架，讓使用者知道「正在分析」，避免無聲等待
      const loadingOverlay = renderLoadingOverlay(el);

      try {
        const resp = await chrome.runtime.sendMessage({
          type: "ANALYZE_TEXT",
          payload: { text, source_url: location.href },
        });
        if (resp?.ok && resp.data) {
          analyzedResults.set(key, resp.data);
          loadingOverlay?.remove();
          handleResult(el, resp.data);
        } else {
          loadingOverlay?.remove();
        }
      } catch (e) {
        console.warn("[Phishing Detector] send message failed:", e);
        loadingOverlay?.remove();
      } finally {
        inFlightHashes.delete(key);
        delete el.dataset.pdInFlight;
      }
    }
  }

  // ---------------------------------------------------------------
  // 3. Loading 骨架渲染（送出請求時立即顯示，消除無聲等待）
  // ---------------------------------------------------------------
  function renderLoadingOverlay(el) {
    if (!el?.parentNode) return null;
    const overlay = document.createElement("div");
    overlay.className = "pd-overlay pd-loading";
    overlay.innerHTML = `
      <div class="pd-banner">
        <span class="pd-spinner" aria-hidden="true"></span>
        <strong>意圖分析中…</strong>
        <span class="pd-meta-inline">LLM 推理約需 3-6 秒</span>
      </div>
    `;
    el.parentNode.insertBefore(overlay, el);
    return overlay;
  }

  // ---------------------------------------------------------------
  // 4. 結果 Overlay 渲染
  //    - 釣魚（High/Medium）→ 紅/橘 警告（含解釋與意圖列表）
  //    - 安全（Low / not phishing）→ 綠色精簡 badge（單行）
  //    讓使用者明確知道「系統已分析」，避免疑慮（Visibility of System Status）
  // ---------------------------------------------------------------
  function handleResult(el, result) {
    if (el.dataset.pdMarked === "1") return;
    el.dataset.pdMarked = "1";

    const isSafe = !result.is_phishing || result.risk_level === "Low";
    const overlay = document.createElement("div");

    if (isSafe) {
      overlay.className = "pd-overlay pd-risk-safe";
      overlay.innerHTML = `
        <div class="pd-banner">
          <span class="pd-icon">✓</span>
          <strong>意圖分析：未偵測到釣魚跡象</strong>
          <span class="pd-meta-inline">${escapeHtml(result.engine)} · ${result.latency_ms}ms</span>
          <button class="pd-close" aria-label="關閉">✕</button>
        </div>
      `;
    } else {
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
    }

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
