# Week 15 個人進度報告

**姓名**：邱冠勳(負責 A前端整合)
**組別**：第 59 組(組員：邱冠勳 S114062328、盧彥宇 S114062317、吳花瑜 S114065534)
**學號**：114062328

**專案**：LLM 意圖導向防釣魚瀏覽器擴充功能 (Intent-Based Phishing Detector)
**個人分工**：組員 A — 前端與系統整合工程師 (Frontend & Integration)

---

## 1. 本週目標

Week 14 我完成了「能在終端機動起來」的 MVP：擴充功能擷取文本 → FastAPI → mock 關鍵字分類器 → 回傳 JSON → 注入警告 Overlay。本週的核心任務是把 **mock 引擎換成真實 LLM**，並完成系統整合的關鍵一哩路：

| 子任務 | 內容 |
| --- | --- |
| LLM 引擎整合 | 串接組員 B 微調後的 GGUF 模型（透過 Ollama） |
| 多引擎架構 | 同時支援本地 fine-tuned 與多個雲端 baseline 熱插拔 |
| 輸出穩定化 | 解析 LLM 自由輸出，強制收斂為前端可解析的 JSON schema |
| 容錯設計 | LLM 離線時的降級策略，確保前端永遠有結果 |
| 前端體感優化 | 辨識中骨架、結果差異化視覺、前端粗篩降低後端負載 |

---

## 2. 系統整合架構：多引擎熱插拔

Week 14 的後端直接呼叫 mock 函式。本週我將 LLM 呼叫抽象成獨立模組 `llm_engine.py`，讓 FastAPI 中繼站能在「本地 Ollama」、「雲端 Gemini」、「雲端 NVIDIA NIM」、「Mock 降級」四個引擎間以單一參數熱插拔。

```
                              ┌─────────────────────────────────┐
   POST /analyze              │   FastAPI 中繼站 (main.py)        │
  {text, engine} ────────────→│   • Pydantic 驗證                 │
                              │   • (engine, text) 快取            │
                              │   • 降級 fallback                  │
                              └───────────────┬─────────────────┘
                                              │ analyze_with_engine(text, engine)
              ┌──────────────────┬────────────┴───────────┬─────────────────┐
              ▼                  ▼                        ▼                 ▼
   ┌───────────────────┐ ┌────────────────────┐ ┌────────────────────┐ ┌──────────┐
   │  call_ollama()    │ │  call_gemini()     │ │  call_nvidia()     │ │ mock     │
   │  本地 fine-tuned  │ │  Google AI Studio  │ │  NVIDIA NIM        │ │ (fallback│
   │  Qwen2.5-7B GGUF  │ │  gemini-3.5-flash  │ │  Llama-3.1-8B      │ │   only)  │
   └─────────┬─────────┘ └──────────┬─────────┘ └──────────┬─────────┘ └──────────┘
             │                      │                      │
             └────────────── 共用 SYSTEM_PROMPT ────────────┘
                             共用 build_user_message()
```

### 2.1 為什麼要共用同一個 Prompt Template

四個引擎共用完全相同的 `SYSTEM_PROMPT` 與 `build_user_message()`，是為了讓引擎間的差異**只剩模型能力本身**。任何 prompt 變動都會同時影響所有引擎，避免「分數差異來自 prompt 差異」的混淆。這是控制變因的工程實踐，也是 §3.4 降級設計能「無痛接手」的前提。

---

## 3. 引擎實作細節

### 3.1 Ollama（本地 fine-tuned 模型）

組員 B 交付了 `Qwen2.5-7B-Instruct.Q4_K_M.gguf`（4-bit 量化，約 4.6GB）與一份 Modelfile。我用 Ollama 建立模型：

```bash
ollama create phishing-detector -f Modelfile
```

**踩坑紀錄 1：B 的 Modelfile 缺 SYSTEM 與溫度設定**

B 給的原始 Modelfile 只有 Qwen 的 chat template 與 stop token，缺兩樣關鍵設定：

1. 沒有 `SYSTEM` 區塊 → `ollama run` 時模型不知道任務目標
2. 沒設 `temperature` → 分類任務需要低溫度避免模型自由發揮

我補上後（`temperature 0.1`、`top_p 0.9`、`num_ctx 4096`，以及與 INPUT_SPEC.md §2.1 一致的 SYSTEM prompt），輸出穩定度大幅提升。

呼叫時使用 Ollama 的 `/api/chat` 並開啟原生 **JSON mode**：

```python
payload = {
    "model": OLLAMA_MODEL,
    "messages": [
        {"role": "system", "content": SYSTEM_PROMPT},
        {"role": "user", "content": build_user_message(text)},
    ],
    "stream": False,
    "format": "json",          # ← 強制輸出合法 JSON，降低解析失敗率
    "options": {"temperature": 0.1},
}
```

### 3.2 雲端 baseline 對照組



| 引擎 | 模型 | 選擇理由 |
| --- | --- | --- |
| **Gemini** | gemini-3.5-flash | Google 旗艦 Flash 系列，原生 JSON mode (`responseMimeType: "application/json"`)，免費層 10 RPM、250 RPD 對被動掃描型 PoC 綽綽有餘 |
| **NVIDIA NIM** | meta/llama-3.1-8b-instruct | NIM API 與 OpenAI 介面相容，hosts 主流開源模型，方便與我們的 Ollama Qwen2.5-7B 做「同等級開源模型」對照 |



### 3.3 輸出收斂：防止 LLM 亂講話導致前端崩潰

即使開了 JSON mode，LLM 仍可能：包 markdown code fence、夾雜說明文字、填出規格外的標籤。我寫了兩道防線：

```python
def _extract_json(raw):
    # 防線一：剝除 ```json ... ``` 外框
    s = re.sub(r"^```(?:json)?\s*", "", raw.strip())
    s = re.sub(r"\s*```$", "", s)
    try:
        return json.loads(s)
    except json.JSONDecodeError:
        # 防線二：用正則抓第一個 {...} 區塊
        m = re.search(r"\{.*\}", s, re.DOTALL)
        if m:
            return json.loads(m.group(0))
    raise ValueError(...)

def normalize_result(data):
    # 強制收斂：risk_level 不在白名單就降級為 Low、
    # detected_intents 過濾非法標籤、explanation 截斷 80 字
    ...
```

這確保**無論 LLM 怎麼亂輸出，前端拿到的永遠是合法的 AnalyzeResponse**，不會因為一次模型抽風而整個擴充功能崩潰。

### 3.4 容錯：降級 fallback

LLM（尤其本地 Ollama）可能因記憶體不足、服務未啟動而失敗。我在 `/analyze` 加上 try/except 降級邏輯：

```python
try:
    result, engine_label = await llm_engine.analyze_with_engine(text, engine)
except Exception as e:
    result = _mock_analyze(text)                       # 退回 Week 14 的關鍵字分類
    engine_label = f"mock-fallback (原因: {type(e).__name__})"
```

並且 **fallback 結果不寫入快取**，下次請求仍會嘗試呼叫真實 LLM。這是「優雅降級 (Graceful Degradation)」的具體實踐。

---

## 4. 整合測試結果

啟動後端（`DEFAULT_ENGINE=ollama`）後，以三筆樣本實測完整資料流：

| 測試文本 | 預期 | 實際輸出 | 延遲 |
| --- | --- | --- | --- |
| 「蝦皮帳戶異常…兩小時內驗證」 | High | ✅ High, [Authority, Urgency] | 6.0s |
| 「下週三 14:00 會議室檢討」 | Low | ✅ Low, [None] | 5.5s |
| 「健保署…驗證信用卡資料」 | High | ✅ High, [Authority, Financial] | 5.6s |
| （重送第 1 筆，測快取） | cache_hit | ✅ cache_hit: true | ~0ms |

模型不只判對風險等級，連 `detected_intents` 與白話 explanation 都正確。例如健保署案例輸出：

> 「假冒健保署要求輸入敏感個資並付款，具有財務風險。」

> [截圖：端終端機顯示 ANALYZE log 與 CACHE HIT log]
> ![螢幕擷取畫面 2026-05-29 002835](https://hackmd.io/_uploads/HJ2pTk8gGe.png)


> [截圖：實際在 Gmail 上注入的警告 Overlay]
> ![image](https://hackmd.io/_uploads/H1_t0yIgGe.png)


**踩坑紀錄 2：Windows curl 中文編碼與 `\n` 字面值問題**

初次以 `curl -d` 直接傳中文 JSON 時遇到 `There was an error parsing the body`，且早期直接打 Ollama 時模型誤判為「亂碼文本」。追查後發現兩個原因：(1) Windows shell 對中文 + 雙引號的跳脫處理會破壞 UTF-8；(2) 我在測試字串中寫的 `\n` 被當成字面反斜線傳入，模型把它視為雜訊。改用 `--data-binary @file.json` 並讓後端統一處理換行後即正常。這也驗證了「前處理應集中在後端」的設計決策。

---

## 5. 延遲問題分析

### 5.1 五組對照實測數據

為了釐清延遲瓶頸究竟出在 LLM 還是網路，我跑了五組對照實驗。**所有數字皆為本週實測，非估算**：

| 引擎部署 | 端到端延遲 | 備註 |
| --- | --- | --- |
| **快取命中**（任一引擎） | < 5ms | 雙層快取設計的成果 |
| **NVIDIA NIM (Llama-3.1-8B)**（雲端 baseline） | ~2.4s | 商用推理服務最快 |
| **Gemini 3.5 Flash**（雲端 baseline） | ~4.8s | Google 旗艦 Flash 系列 |
| **Ollama Qwen2.5-7B fine-tuned (Colab T4 + tunnel)** | 5 – 6s | 本 PoC 主要方案 |
| **本機 CPU**（i7 / 16GB RAM） | 5.5 – 6.0s | 無 GPU 對照組 |

> [截圖：Colab 上的 `nvidia-smi` 截圖，顯示 Tesla T4 + ollama 進程佔用 4880MiB VRAM]
> ![image](https://hackmd.io/_uploads/BkjpbJUeGx.png)

> [截圖：FastAPI 終端機顯示三引擎 ANALYZE log，可看到 engine 欄位分別為 ollama / gemini / nvidia]
> ![螢幕擷取畫面 2026-05-29 002907](https://hackmd.io/_uploads/HJNk1xIeze.png)


### 5.2 延遲構成拆解

從上述兩組數據可推導出延遲的構成：

```
本機 CPU 路徑：
  └─ CPU 推理（7B Q4_K_M）   ~5.5s  ⇐ 完全 CPU 瓶頸

Colab T4 路徑：
  ├─ Cloudflare tunnel（台灣 ⇄ Colab）  ~2-3s
  └─ T4 推理（GPU 上）                   ~3s
      ├─ Prompt eval (~500 token system prompt)  ~1.0s  @ ~500 tok/s
      └─ Generation (~50 token JSON output)      ~1.5s  @ ~35 tok/s
```

**關鍵發現**：T4 雖比 CPU 快但**沒有大幅提升**，因為：

1. **System prompt 長度為主要瓶頸**：意圖定義、規則、輸出格式三段共 ~500 tokens。Prompt eval 階段（讀入 prompt）就佔了 1 秒，佔總推理時間 40%
2. **T4 是 2018 年產品，吞吐率有限**：對 7B Q4_K_M 大約 35 tok/s 生成速度，已是該硬體上限
3. **網路 overhead 不可忽略**：trycloudflare 反向代理從台灣→Cloudflare 邊緣→Colab 來回約 2-3 秒，比本機 CPU 推理時間還長

### 5.3 為什麼此 PoC 接受 5-6 秒延遲

這個延遲對「使用者瀏覽網頁無感」的標準確實偏高，但對本 PoC 屬可接受範圍：

1. **使用情境不是即時對話**：使用者開信當下不會死盯讀取，警告 Overlay 在 5-6 秒後彈出仍有預防效果
2. **前端 loading 狀態消除焦慮**：本週實作骨架 Overlay 立即注入，分析完替換為正式警告（詳見 §6.2）
3. **快取命中時 < 5ms**：同封信件重開時已是「無感」（呼應 Week 14 設計的前端 Map + 後端 SHA-256 雙層快取）
4. **資源限制下的合理取捨**：本 PoC 在學生帳號 / 免費資源約束下，不追求 production-grade 延遲

### 5.4 架構限制與資安權衡

雲端 GPU 部署雖能解決延遲，卻引入三個新議題，這正是「資安系統設計權衡」的真實案例：

| 議題 | 影響 | 緩解方案 |
| --- | --- | --- |
| trycloudflare URL 公開無認證 | 知道網址者皆可呼叫 LLM | Cloudflare Access + OAuth；正式部署應用具名 tunnel |
| 文本透過 HTTPS 出本機 | 仍屬「資料離開使用者裝置」 | 強調零洩漏者應堅守純本地；雲端模式宜標示為「效能優先」 |
| Colab 12 小時 / 90 分鐘 idle 斷線 | 無法 24/7 服務 | FastAPI 內建降級 fallback 自動退回 mock，前端不會壞 |

這呼應課程「Data Privacy vs Performance」的雙刃。本 PoC 透過 Options 頁讓使用者**顯式選擇**「本地模式（極致隱私）」或「雲端模式（極致延遲）」，將決定權交還使用者。

### 5.5 四引擎架構決策矩陣

整合上述所有實測與分析，下表彙整四個可用引擎在資安系統設計時需考量的四個關鍵軸線：

| 引擎 | 端到端延遲 | 資料外洩風險 | 月成本（PoC 用量） | 服務可用性 |
| --- | --- | --- | --- | --- |
| **Ollama 本機 CPU** | 5 – 6s | **零**（資料完全留本機） | $0 | 100%（本機） |
| **Ollama Colab + cloudflared** | 5 – 6s | 中（HTTPS 出本機，trycloudflare URL 無認證） | $0（Colab 免費 T4） | ~70%（Colab 12hr 上限、90 分鐘 idle 斷線） |
| **Gemini 3.5 Flash** | 4.8s | 高（文本送 Google） | $0（免費層 250 RPD） | 99.9%（Google SLA） |
| **NVIDIA NIM (Llama-3.1-8B)** | 2.4s | 高（文本送 NVIDIA） | $0（免費額度） | 99.9%（NVIDIA SLA） |
| **Mock fallback** | < 50ms | 零 | $0 | 100% |

**設計上的核心觀察**：

1. **沒有任何單一引擎在四軸都最佳**——這正是資安系統設計中的「不可三全」現實
2. **延遲與隱私呈反向關係**：商用 API（延遲低）必然伴隨資料外送；本地推理（無外送）必然受限於本機硬體
3. **降級策略讓可用性問題消失**：即使 Colab session 斷線、Gemini quota 超限、NVIDIA NIM 維護中，FastAPI 都會自動退回 mock，前端使用者**永遠不會看到完全失能**
4. **使用者擁有最終決定權**：Options 頁的引擎切換把這個權衡明確攤給使用者，符合「Security by Design」與「Informed Consent」的雙重原則



---

## 6. 前端體感與視覺反饋優化

由於本機推理延遲 5-6 秒、雲端引擎 2-5 秒不等，「直接送後端等結果」會造成使用者長時間無回應的焦慮。本章節整合本週三項前端 UX 改進：粗篩減少無謂請求、辨識中 loading 骨架、辨識後依結果差異化視覺。

### 6.1 前端粗篩：減少無謂的後端呼叫

每次 LLM 推理花 5-6 秒，若每個 DOM 節點都丟去分析會造成嚴重浪費。Content Script 在送出請求**之前**先做四道過濾：

```javascript
function shouldSkip(el, text) {
  if (text.length < 20) return "too_short";       // 1. 短於 20 字
  if (!/[一-鿿]/.test(text)) return "no_cjk";     // 2. 無中文字元
  const rect = el.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0)
    return "invisible";                            // 3. 隱形元素
  const linkText = Array.from(el.querySelectorAll("a"))
    .map(a => a.innerText || "").join("").length;
  if (linkText / text.length > 0.7)
    return "link_heavy";                           // 4. 連結密度 > 70%
  return null;
}
```

| 規則 | 過濾掉 | 設計理由 |
| --- | --- | --- |
| 文本 < 20 字 | 按鈕、標題列 | 短文本本就無法判斷意圖 |
| 無中文字元 | 純英數 URL / nav / ID | 本系統設計針對繁中釣魚，純英文走 fallback 容易誤判 |
| 元素 0×0 或 display:none | 隱藏節點 | DOM 上存在但使用者看不到，分析無意義 |
| 連結文字 / 內文 > 70% | 選單列、瀏覽列 | 高連結密度幾乎都是導覽，非內容 |

這四道篩選把後端壓力降到最低，從報告層面也是「**Defense in Depth**」的具體實踐——前端與後端各承擔部分職責，不全押在 LLM 上。

### 6.2 辨識中：Loading 骨架 + In-flight 防分身

送出請求後立即注入灰色「⟳ 意圖分析中…」單行 banner，使用者明確知道系統正在處理：

```javascript
function renderLoadingOverlay(el) {
  const overlay = document.createElement("div");
  overlay.className = "pd-overlay pd-loading";
  overlay.innerHTML = `
    <div class="pd-banner">
      <span class="pd-spinner"></span>
      <strong>意圖分析中…</strong>
      <span class="pd-meta-inline">LLM 推理約需 3-6 秒</span>
    </div>
  `;
  el.parentNode.insertBefore(overlay, el);
  return overlay;
}
```

**踩坑紀錄 5：MutationObserver 與 Loading Overlay 的「分身」問題**

初版實作上線後立刻發現一個嚴重 bug：每封信件不只一個 loading 骨架，而是**無限分身越長越多條**。追查原因：

1. Content Script 插入 loading overlay → 觸發 MutationObserver
2. Observer debounce 後重新呼叫 `scanAndAnalyze()`
3. 新一輪 scan 內的 `seenInThisScan` 是空 Set，舊節點的 `analyzedResults` 還沒寫入（因為仍在 `await` 後端），於是又被當成「未分析」
4. 再插入一個 loading overlay → 又觸發 observer → 無限迴圈

修法用「in-flight 雙層追蹤」（hash 層 + DOM 元素層）：

```javascript
const inFlightHashes = new Set();
// 在 scanAndAnalyze 內：
if (inFlightHashes.has(key)) continue;
if (el.dataset.pdInFlight === "1") continue;
inFlightHashes.add(key);
el.dataset.pdInFlight = "1";
try { /* await 後端 */ }
finally {
  inFlightHashes.delete(key);
  delete el.dataset.pdInFlight;
}
```

這也呼應 §3.3 輸出收斂的設計哲學——LLM 系統的任何「不可靠時序」處都必須加層防護，這是與傳統 CRUD API 最大的工程差異。

> [截圖：在 Gmail 上開信件當下，看到灰色「⟳ 意圖分析中… LLM 推理約需 3-6 秒」banner]
> ![image](https://hackmd.io/_uploads/BJ6A1lIlGx.png)


### 6.3 辨識後：依結果差異化視覺重量

`handleResult()` 初版對 `is_phishing: false` 或 `risk_level: Low` 直接早退、不渲染任何 Overlay，造成使用者體驗「Loading 出現 → 消失 → 沒下文」。這違反 Nielsen 十大易用性原則第一條 **Visibility of System Status**——使用者無法確認系統是否真的掃描過。

修正後所有結果都會渲染 Overlay，但釣魚與安全採用**不同視覺重量**：

| 結果 | Overlay 形式 | 高度 | 包含資訊 |
| --- | --- | --- | --- |
| High / Medium 釣魚 | 紅／橘 警告 banner + 展開區 | 高（兩段） | 風險等級、解釋、攻擊意圖、引擎、延遲 |
| 分析中 | 灰色單行 banner + spinner | 低（單行） | 「意圖分析中…」+ 提示文字 |
| Low / 安全 | 綠色精簡 banner | 低（單行） | ✓ 標記、引擎、延遲 |

綠色 badge 故意做得比警告更小，避免一堆正常信件顯示綠條造成視覺噪音；同時保留 ✕ 關閉按鈕，給使用者最終控制權。

> [截圖：Gmail 上一封正常會議信件，顯示綠色「✓ 意圖分析：未偵測到釣魚跡象」單行 badge]
> ![image](https://hackmd.io/_uploads/BkMZglUxMg.png)


---

## 7. 本週實際完成清單

回顧 §1 開頭設定的目標，本週交付完成度如下：

| 子任務 | 狀態 | 對應章節 |
| --- | --- | --- |
| LLM 引擎整合（Ollama 本地） | ✅ 完成 | §3.1 |
| 多引擎架構（雲端 baseline） | ✅ 完成，實際做出**四引擎**（ollama / gemini / nvidia / mock-fallback） | §3.2 |
| 輸出穩定化（JSON 收斂） | ✅ 完成 | §3.3 |
| 容錯設計（降級 fallback） | ✅ 完成 | §3.4 |
| 前端粗篩 | ✅ 完成 | §6.1 |
| 辨識中 Loading 骨架 + 防分身 | ✅ 完成 | §6.2 |
| 安全結果視覺反饋（綠色 ✓ badge） | ✅ 完成 | §6.3 |
| Options 引擎切換接後端 | ✅ 完成（超出原規劃） | — |
| Colab + cloudflared 遠端推理 | ✅ 完成（超出原規劃） | §5 |

---

## 8. 結語

Week 15 完成了從「玩具 mock」到「真實 LLM 系統」的關鍵躍遷。技術上最有價值的不是「呼叫到模型」本身（任何人都能 call API），而是圍繞 LLM 不可靠性所做的**工程防護**：

- 輸出收斂（`normalize_result`）→ 防模型亂講話
- 降級 fallback → 防服務中斷
- 雙引擎共用 prompt → 確保對照實驗科學性
- 快取分引擎 key → 防結果污染

這呼應課程強調的——將 LLM 從「不可控的黑盒」收束為「可在生產環境信賴的元件」，正是 LLM 資安應用的工程核心。

---

**附錄：本週新增/修改檔案**

```
backend/
├── llm_engine.py     # 新增：三引擎抽象層 + prompt + 輸出收斂
└── main.py           # 改寫：雙引擎路由 + 降級 fallback + 分引擎快取
Modelfile             # 修改：補上 SYSTEM + temperature 等參數
INPUT_SPEC.md         # 新增：三層輸入規格（跨團隊契約）
```


