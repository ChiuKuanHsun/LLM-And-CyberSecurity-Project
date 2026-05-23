# Week 14 個人進度報告

**姓名**：邱冠勳
**組別**：第 59 組
**學號**：114062328

**專案**：LLM 意圖導向防釣魚瀏覽器擴充功能 (Intent-Based Phishing Detector)
**個人分工**：組員 A — 前端與系統整合工程師 (Frontend & Integration)

---

## 1. 個人職責與本週目標

依據團隊三人分工（A 前端整合 / B 資料微調 / C Prompt 與評估），我於本週負責的子系統為：

| 子系統 | 內容 |
| --- | --- |
| Chrome Extension (Manifest V3) | 擴充功能骨架、權限設計、Service Worker |
| Content Script | 從目標網頁 DOM 萃取純文本，過濾雜訊 |
| FastAPI 中繼站 | 接收前端文本 → 預留 LLM 介面 → 回傳結構化 JSON |
| API 規格 (Contract) | 與組員 B / C 對齊後端輸出 schema |

本週的核心目標是產出**能在終端機裡動起來**的最簡可行產品 (MVP)：能讓擴充功能擷取 Gmail 信件內容、送至本機 FastAPI、收到穩定的 JSON 風險評估結果，即使後端目前以關鍵字 mock 模擬 LLM 也能讓組員 B 與 C 平行開工。

---

## 2. 系統架構與資料流

整個 PoC 採用「**前端 — 中繼後端 — LLM 引擎**」三層架構。下圖為 Week 14 版本的資料流，後續 Week 15 將以微調模型 / Ollama 取代 mock 引擎。

```
┌────────────────────────────────────────────────────────────┐
│                       Browser                              │
│  ┌─────────────────────┐         ┌────────────────────┐    │
│  │  Content Script     │ ─msg→   │  Service Worker    │    │
│  │  • DOM 擷取         │         │  • 統一 fetch       │    │
│  │  • Overlay 注入     │ ←msg─   │  • 端點管理         │    │
│  └─────────────────────┘         └──────┬─────────────┘    │
└────────────────────────────────────────│───────────────────┘
                                         │ POST /analyze
                                         ▼
                       ┌──────────────────────────────┐
                       │   FastAPI 中繼站 (127.0.0.1:8080)
                       │   • Pydantic Schema 驗證      │
                       │   • SHA-256 快取去重          │
                       │   • Mock keyword analyzer     │
                       │     (Week 15 換成 LLM)        │
                       └──────────────────────────────┘
```


### 2.1 為什麼需要中繼後端

原本可考慮讓 Content Script 直接呼叫 OpenAI API，但這樣會：

1. **暴露 API Key**：擴充功能可被反編譯，金鑰會外流
2. **無法切換引擎**：Week 16 要做 Baseline (雲端) vs Fine-tuned (本地 Ollama) 對比實驗，前端硬編碼端點無法靈活切換
3. **重複分析**：同一封信件可能多次被掃描，沒有共享快取會浪費 token

因此設計上選擇用一支輕量 FastAPI 作為中繼站，所有 LLM 呼叫都集中在伺服器端管理。

---

## 3. Chrome Extension Manifest V3 環境建置

### 3.1 Manifest V3 的差異

Chrome 自 2024 起全面淘汰 Manifest V2，本專案以 MV3 從零建置。與 MV2 相比關鍵差異：

| 項目 | MV2 (舊) | MV3 (本專案採用) |
| --- | --- | --- |
| 背景腳本 | Persistent background page | Service Worker (短生命週期) |
| 遠端程式碼 | 可載入 | 嚴格禁止（CSP 強化） |
| Host 權限 | `permissions` 內 | 獨立 `host_permissions` 欄位 |
| Fetch 來源 | 任意 | 必須先於 `host_permissions` 宣告 |

### 3.2 權限設計（最小特權原則）

`manifest.json` 中只請求**必要**權限，並把可能擴充的網域劃進 `optional_host_permissions`，於執行期再請求：

```json
{
  "permissions": ["activeTab", "scripting", "storage"],
  "host_permissions": [
    "http://127.0.0.1:8080/*",
    "https://mail.google.com/*",
    "https://*.facebook.com/*",
    "https://*.line.me/*"
  ],
  "optional_host_permissions": [
    "https://*/*",
    "http://*/*"
  ]
}
```

設計考量：

- **不使用 `<all_urls>`**：避免上架審查爭議，也符合資安課程強調的「最小特權」
- **`activeTab` 而非全域 tab 存取**：使用者點擊擴充功能圖示時才授權當前分頁
- **localhost 例外**：MV3 雖規定外部請求必須 HTTPS，但 `127.0.0.1` 屬例外，得以在 PoC 階段直接打本機 FastAPI
- **`optional_host_permissions`**：將「未來可能需要」的網域宣告為**選用**，安裝時並不會直接授權。實際請求時機留到 §3.4 描述


> [截圖：`chrome://extensions/` 載入未封裝項目，擴充功能成功顯示]
> ![載入成功](https://hackmd.io/_uploads/rJYtmH1xfx.png)

### 3.3 Service Worker 設計

由於 Content Script 無法直接以任意來源 fetch，且每個分頁的 Content Script 都會獨立執行，將 fetch 邏輯下放到 Service Worker (`background.js`) 帶來三個優勢：

1. 統一管理 endpoint（Week 16 切換 Baseline / Local 一行搞定）
2. 跨分頁共享 `chrome.storage` 設定
3. 利於後續加入 retry / rate-limit

關鍵程式碼片段：

```javascript
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === "ANALYZE_TEXT") {
    analyzeText(msg.payload).then(sendResponse);
    return true;  // 非同步回覆，必須 return true
  }
});
```

### 3.4 動態權限管理：使用者自訂掃描網站

#### 痛點

若把所有支援的 webmail 網域（Gmail、Outlook、Yahoo、ProtonMail、自架 mail server……）全部寫進 `manifest.json` 的 `host_permissions`，會造成兩個問題：

1. **權限膨脹違反 PoLP**：使用者只用 Gmail，卻被一次性要求授權十幾個網域，安裝時的授權彈窗會嚇跑使用者
2. **新增網站要重新發版**：每次擴充支援的 webmail 都得改 manifest，使用者必須重新授權所有舊網域

#### 解法：Optional Permissions + 動態 Content Script 註冊

採用 MV3 提供的兩項機制組合：

| 機制 | 作用 |
| --- | --- |
| `chrome.permissions.request({ origins })` | 執行期主動請求單一網域權限，觸發 Chrome 原生授權彈窗 |
| `chrome.scripting.registerContentScripts()` | 不改 manifest，動態將 Content Script 注入新網域 |
| `chrome.permissions.remove()` | 使用者移除自訂網站時撤回權限，不留尾巴 |
| `chrome.storage.sync` | 跨裝置同步清單，重啟瀏覽器自動恢復 |

#### 流程設計（Options Page → Service Worker）

```
[Options Page]                    [Service Worker]
    │  輸入 URL 點「新增」              │
    │ ──── ADD_SITE message ──────→ │
    │                                │ 1. normalizePattern() 正規化為 origin/*
    │                                │ 2. chrome.permissions.request()
    │                                │    → 瀏覽器跳出原生授權彈窗
    │  ←──── (使用者點「允許」) ───── │
    │                                │ 3. chrome.scripting.registerContentScripts()
    │                                │ 4. chrome.storage.sync.set()
    │ ←──── { ok: true, site } ──── │
    │  重新渲染清單                    │
```

#### 關鍵實作：`background.js` 內 `addCustomSite()`

```javascript
async function addCustomSite({ pattern, label }) {
  const normalized = normalizePattern(pattern);  // 例：outlook.live.com → https://outlook.live.com/*

  // 1. 觸發 Chrome 原生授權彈窗（必須使用者明確同意）
  const granted = await chrome.permissions.request({ origins: [normalized] });
  if (!granted) return { ok: false, error: "使用者拒絕授權" };

  // 2. 動態注入 Content Script
  const id = "user_site_" + Date.now().toString(36);
  await chrome.scripting.registerContentScripts([{
    id, matches: [normalized], js: ["content.js"], css: ["overlay.css"],
    runAt: "document_idle",
  }]);

  // 3. 寫入 storage，供下次重啟恢復
  const sites = await listCustomSites();
  sites.push({ id, pattern: normalized, label });
  await saveCustomSites(sites);
  return { ok: true };
}
```

#### 抗失效設計：啟動時對齊

Chrome 官方雖宣稱動態 Content Script 會持久化，但實測在瀏覽器更新後偶有掉失，因此在 `onStartup` 與 `onInstalled` 兩個生命週期掛上 `syncRegisteredScripts()`：

- 讀取 `storage` 內的使用者清單
- 比對 `chrome.scripting.getRegisteredContentScripts()` 實際註冊狀態
- 比對 `chrome.permissions.getAll()` 確認授權仍在
- 對齊差異後重新註冊

這保證即使瀏覽器升級導致動態註冊掉失，重啟後也會自動恢復。

> [截圖：Options 頁的「自訂掃描網站」UI，包含新增表單與已註冊網站清單]
> ![設定UI](https://hackmd.io/_uploads/HyfsLSkxGx.png)


> [截圖：點「＋ 新增」後 Chrome 跳出的原生授權彈窗（「允許 / 拒絕」對話框）]
> ![權限獲取](https://hackmd.io/_uploads/r1M6IByxzl.png)


#### 在期末報告的論述價值

這段設計可呼應課程強調的 **Principle of Least Privilege (PoLP)** 與 **Just-in-Time Authorization**：

> 「傳統 Chrome 擴充功能將 host_permissions 寫死在 manifest 中，每次擴充支援網站都需重新發版且要求使用者一次授權全部網域。本系統採用 **MV3 Optional Permissions + Dynamic Content Script Registration**，使用者可依個人偏好（Outlook、Yahoo、ProtonMail、自架 mail server）動態擴充，且每筆授權皆需明確同意，將擴充功能本身的攻擊面降至最低。」

---

## 4. DOM 文本擷取演算法

### 4.1 痛點：HTML 雜訊會讓 LLM Token 爆炸

直接抓 `document.body.innerText` 雖然可行，但 Gmail 一頁含 sidebar、廣告、其他信件預覽，單次擷取常超過 10,000 字，會造成：

- **Token 成本高**：商業 API 以 token 計費
- **意圖被稀釋**：LLM 注意力被無關文字干擾，誤判率上升

### 4.2 解法：站點化 Selector + 文本清洗

我在 `content.js` 為各站點定義精準的 CSS Selector：

```javascript
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
```

選定容器後，再做三層清洗：

1. **節點移除**：clone 一份節點樹，刪掉 `<script>`、`<style>`、`<noscript>`、`<img>`、`<svg>`，避免把 inline JS 字串或圖片 alt 也送進 LLM
2. **空白合併**：`\s+` 全部換成單一空格
3. **長度截斷**：最多 5,000 字（後端再次以 `max_length=20000` 兜底防護）

```javascript
function extractText(el) {
  const clone = el.cloneNode(true);
  clone.querySelectorAll("script, style, noscript, img, svg").forEach(n => n.remove());
  const text = clone.innerText || clone.textContent || "";
  return text.replace(/\s+/g, " ").trim().slice(0, 5000);
}
```

> [📷 截圖 3：實際在 Gmail 上開啟一封信，DevTools Console 印出 extractText() 萃取後的純文字結果]

### 4.3 重複分析防護：djb2 hash 去重

Gmail 是 SPA，使用者切換信件時 DOM 會反覆變動，若不去重會把同一封信送十幾次。我用 djb2 hash 對擷取後的文本做指紋，存進 `Set` 內：

```javascript
function hashString(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return h.toString(36);
}
```

不用 SHA-256 是因為這裡只需去重，不需密碼學強度，且 djb2 純前端執行極快（< 0.1ms）。後端 FastAPI 端則用 SHA-256，因為快取要跨會話保留。

### 4.4 MutationObserver + Debounce

```javascript
const observer = new MutationObserver(scheduleScan);
observer.observe(document.body, { childList: true, subtree: true });
function scheduleScan() {
  clearTimeout(analyzeTimer);
  analyzeTimer = setTimeout(scanAndAnalyze, 500);
}
```

500ms debounce 避免使用者快速滾動時瘋狂觸發掃描，這也是 Week 15 要重點優化的「延遲與體感」議題。

---

## 5. FastAPI 後端與 API 規格

### 5.1 與組員 B、C 對齊的 JSON Schema

為了讓三人能平行開發，本週優先把後端的 **輸出契約 (response contract)** 凍結下來。任何後續 LLM 改動（包含組員 C 換 Prompt、組員 B 換成微調模型）都必須產出符合此 schema 的 JSON。

```python
class AnalyzeResponse(BaseModel):
    is_phishing: bool
    risk_level: Literal["High", "Medium", "Low"]
    detected_intents: list[ThreatIntent]
    explanation: str          # <= 50 字繁中
    latency_ms: int
    engine: str               # 對照實驗用
    cache_hit: bool = False
```

`engine` 欄位是我特別加上的，便於 Week 15 跑 Baseline vs Fine-tuned 比較時，從回應 JSON 直接讀出當下用的是哪個引擎，方便產出量化圖表。

### 5.2 Mock Analyzer：先讓前端能跑通

Week 14 後端尚未串真實 LLM，我用一個關鍵字計分器 mock 出風險評估：

```python
_INTENT_KEYWORDS = {
  "Urgency":   ["立即", "限時", "24小時內", "兩小時內", "逾期", "停權", "凍結"],
  "Authority": ["客服", "官方", "銀行", "蝦皮", "健保署", "國稅局", "郵局"],
  "Financial": ["匯款", "點數", "轉帳", "薪資", "退稅", "信用卡"],
  "Greed":     ["中獎", "免費", "領取", "禮品", "優惠", "紅包"],
}
```

命中 2 種以上 → `High`，命中 1 種 → `Medium`，否則 `Low`。這顯然遠遠不如 LLM 強，但對「驗證前端能正確顯示警告」已綽綽有餘。

### 5.3 快取：SHA-256 指紋

```python
def _cache_key(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()
```

Week 14 用記憶體 `dict` 暫存，Week 15 會評估改用 Redis 或 SQLite。

### 5.4 CORS 設定

擴充功能來源是 `chrome-extension://<不固定 ID>`，開發階段先以 `allow_origins=["*"]` 處理，Week 16 報告會把這列為架構限制之一，正式上架後應改為發布版的固定 extension ID。

> [截圖：瀏覽器開啟 `http://127.0.0.1:8080/docs` 看到 Swagger UI 自動生成的 API 文件]
> ![swagger](https://hackmd.io/_uploads/rJRmOHyxMe.png)


> [截圖：在 Swagger UI 內輸入測試文本後，後端回傳的 JSON 結果（顯示 High / Urgency+Authority）]
> ![模擬測試](https://hackmd.io/_uploads/BJRcdS1gzl.png)


---

## 6. 系統整合測試（端到端）

### 6.1 測試流程

1. 啟動 venv → `pip install -r backend/requirements.txt` → `uvicorn main:app --reload`
2. Chrome 載入未封裝擴充功能（`chrome://extensions/`）
3. 開啟 Gmail，瀏覽一封內含「停權 + 兩小時內」字樣的測試信件
4. 觀察 DOM 是否有警告 Overlay 被注入

### 6.2 測試樣本

我準備了 3 封手寫測試信件，模擬常見台灣詐騙情境：

| 編號 | 標題 | 預期 risk | 預期意圖 |
| --- | --- | --- | --- |
| T1 | 「蝦皮帳戶異常，請於兩小時內驗證」 | High | Urgency + Authority |
| T2 | 「您中獎了，請點此領取 LINE Pay 紅包」 | High | Greed + Authority |
| T3 | 同事寄來的會議邀請信 | Low | None |

> [截圖：測試信件在 Gmail 上方成功跳出紅色警告 Overlay 的畫面]
> ![觸發警告](https://hackmd.io/_uploads/B1c_crkeGx.png)



> [截圖：正常信件未觸發警告（驗證沒有 False Positive）]
> ![正常郵件](https://hackmd.io/_uploads/ryD29rklfl.png)


---

## 7. 遇到的困難與解決方案

### 7.1 Service Worker 生命週期問題

**問題**：第一次測試時，`chrome.runtime.sendMessage` 偶爾收不到回覆。

**原因**：MV3 Service Worker 預設 30 秒無事件就會被瀏覽器關閉，而我原本的 listener 沒有 `return true`，導致 `sendResponse` 在 Service Worker 被關閉後才呼叫。

**解法**：所有非同步處理的 listener 都必須 `return true` 才能延遲回覆：

```javascript
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === "ANALYZE_TEXT") {
    analyzeText(msg.payload).then(sendResponse);
    return true;  // ← 這行很關鍵
  }
});
```

### 7.2 Gmail SPA 的 DOM 變動暴衝

**問題**：第一版沒做 debounce，使用者光是滾動信件列表就會觸發數十次 `scanAndAnalyze`。

**解法**：用 `setTimeout` 做 500ms debounce，配合 djb2 hash Set 去重。實測下來，滾動 30 秒只送出 3~5 次有效分析請求。

### 7.3 CORS preflight 失敗

**問題**：擴充功能第一次打 `POST /analyze` 收到 CORS error。

**原因**：瀏覽器會先發 `OPTIONS` preflight，預設 FastAPI 沒有處理。

**解法**：加入 `CORSMiddleware`，並明確列出 `allow_methods=["POST", "GET", "OPTIONS"]`。

---



## 8. 下週工作規劃 (Week 15)

依里程碑要求，Week 15 我的主要任務是：

1. **整合組員 C 的真實 Prompt**：在 FastAPI 內接 OpenAI API，把 mock_analyze() 換掉
2. **整合組員 B 的本地模型**：實作 Ollama endpoint 切換邏輯，量測 Baseline vs Fine-tuned 的延遲與準確度
3. **UI/UX 強化**：警告 Overlay 增加「為什麼這封信危險」的展開細節、降低警報疲勞
4. **延遲優化**：考慮在前端先做粗篩，文本長度 < 20 字或全英文等狀況直接跳過後端呼叫
5. **錯誤處理**：後端離線時前端應有降級體驗（顯示「保護未啟用」提示，而非無聲失敗）

---

## 10. 結語

Week 14 的核心價值不在於做出一個強大的釣魚偵測器，而在於把**架構基底打穩**：

- 前後端介面凍結 → 三人可平行開發
- Service Worker 集中管理端點 → Week 16 切換 Baseline / Local 一行搞定
- 站點化 Selector + 雙層長度防護 → 後續接真實 LLM 時不會因 token 爆炸而吃成本

呼應課程第 12 週投影片的核心觀點：

> We shifted from rule-based signature detection to **dynamic behavioral / intent understanding**.

本擴充功能正是這個典範轉移的具體實踐——我們不再用黑名單比對 URL，而是讓 LLM 真正讀懂訊息背後的「攻擊意圖」。

---

**附錄**

- 程式碼倉庫結構
  ```
  Project/
  ├── backend/
  │   ├── main.py          # FastAPI 中繼站
  │   ├── requirements.txt
  │   └── README.md
  ├── extension/
  │   ├── manifest.json
  │   ├── background.js
  │   ├── content.js
  │   ├── overlay.css
  │   ├── popup.html / popup.js
  │   ├── options/
  │   │   ├── options.html
  │   │   └── options.js
  │   └── README.md
  └── report/
      └── Week14_組員A_個人報告.md
  ```

