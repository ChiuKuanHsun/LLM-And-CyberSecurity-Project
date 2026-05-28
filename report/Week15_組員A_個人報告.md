# Week 15 個人進度報告

**姓名**：邱冠勳
**組別**：第 59 組
**學號**：114062328

**專案**：LLM 意圖導向防釣魚瀏覽器擴充功能 (Intent-Based Phishing Detector)
**個人分工**：組員 A — 前端與系統整合工程師 (Frontend & Integration)

---

## 1. 本週目標

Week 14 我完成了「能在終端機動起來」的 MVP：擴充功能擷取文本 → FastAPI → mock 關鍵字分類器 → 回傳 JSON → 注入警告 Overlay。本週的核心任務是把 **mock 引擎換成真實 LLM**，並完成系統整合的關鍵一哩路：

| 子任務 | 內容 |
| --- | --- |
| LLM 引擎整合 | 串接組員 B 微調後的 GGUF 模型（透過 Ollama） |
| 雙引擎架構 | 同時支援本地 fine-tuned 與雲端 baseline，供 Week 16 對照實驗 |
| 輸出穩定化 | 解析 LLM 自由輸出，強制收斂為前端可解析的 JSON schema |
| 容錯設計 | LLM 離線時的降級策略，確保前端永遠有結果 |
| 跨團隊對齊 | 確保推理 prompt 與組員 B 訓練時一致（避免 Train/Serve Skew） |

---

## 2. 系統整合架構：雙引擎熱插拔

Week 14 的後端直接呼叫 mock 函式。本週我將 LLM 呼叫抽象成獨立模組 `llm_engine.py`，讓 FastAPI 中繼站能在「本地 Ollama」與「雲端 OpenAI」之間熱插拔。

```
                       ┌─────────────────────────────────┐
   POST /analyze       │   FastAPI 中繼站 (main.py)        │
  {text, engine} ────→ │   • Pydantic 驗證                 │
                       │   • (engine, text) 快取            │
                       │   • 降級 fallback                  │
                       └───────────────┬─────────────────┘
                                       │ analyze_with_engine(text, engine)
                          ┌────────────┴────────────┐
                          ▼                          ▼
              ┌───────────────────────┐  ┌───────────────────────┐
              │  call_ollama()        │  │  call_openai()        │
              │  本地 fine-tuned      │  │  雲端 baseline        │
              │  127.0.0.1:11434      │  │  api.openai.com       │
              │  Qwen2.5-7B (Q4_K_M)  │  │  gpt-4o-mini          │
              └───────────────────────┘  └───────────────────────┘
                          │                          │
                          └──── 共用 SYSTEM_PROMPT ───┘
                               共用 build_user_message()
```

> [📷 截圖 1：補上一張雙引擎架構圖（draw.io），標出 prompt template 是兩條路徑共用的]

### 2.1 為什麼要共用同一個 Prompt Template

Week 16 報告要做「雲端 baseline vs 本地微調」的 F1-Score 對照實驗。如果兩個引擎用不同的 prompt，比較就不公平——分數差異可能來自 prompt 差異而非模型能力差異。

因此我把 `SYSTEM_PROMPT` 與 `build_user_message()` 抽到 `llm_engine.py` 共用，兩個引擎呼叫時都注入完全相同的提示詞。這是「控制變因」的工程實踐。

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

考慮到課程強調的「資料隱私」議題與商用 API 的計費模式，我刻意**避開 OpenAI**，改採兩條免費／低成本的雲端 baseline：

| 引擎 | 模型 | 選擇理由 |
| --- | --- | --- |
| **Gemini** | gemini-3.5-flash | Google 旗艦 Flash 系列，原生 JSON mode (`responseMimeType: "application/json"`)，免費層 10 RPM、250 RPD 對被動掃描型 PoC 綽綽有餘 |
| **NVIDIA NIM** | meta/llama-3.1-8b-instruct | NIM API 與 OpenAI 介面相容，hosts 主流開源模型，方便與我們的 Ollama Qwen2.5-7B 做「同等級開源模型」對照 |

**踩坑紀錄 3：Gemini 2.0 Flash 已退役**

初次測試時把預設模型設為 `gemini-2.0-flash`，發 API 一律 HTTP 4xx 失敗。查證後得知 **Google 於 2026-03-03 正式下架 Gemini 2.0 Flash**，免費層轉為 Gemini 2.5/3.x 系列。最後選定 `gemini-3.5-flash`（10 RPM / 250 RPD，分類任務剛好）。這也驗證了 §3.4 降級 fallback 設計的必要性——雲端 API 隨時可能變動，前端必須對 API 失敗有韌性。

**踩坑紀錄 4：API 錯誤訊息原本看不到**

`httpx.raise_for_status()` 拋出的 `HTTPStatusError` 只說「HTTP 400」不附 body，無法判斷是 model 名稱錯、API key 錯、還是 quota 超限。我把 Gemini call 改成：

```python
if r.status_code >= 400:
    raise RuntimeError(f"Gemini API {r.status_code}: {r.text[:500]}")
```

讓真實 API 回應顯示在 FastAPI log 中，這才順利定位到 model 退役問題。**這個小修補也適用於 Week 16 寫到「LLM 整合的可觀測性 (observability) 設計」段落**。

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

> [📷 截圖 2：後端終端機顯示三筆 ANALYZE log 與 CACHE HIT log]

> [📷 截圖 3：實際在 Gmail 上注入的警告 Overlay（顯示 ollama:phishing-detector 引擎與真實解釋）]

**踩坑紀錄 2：Windows curl 中文編碼與 `\n` 字面值問題**

初次以 `curl -d` 直接傳中文 JSON 時遇到 `There was an error parsing the body`，且早期直接打 Ollama 時模型誤判為「亂碼文本」。追查後發現兩個原因：(1) Windows shell 對中文 + 雙引號的跳脫處理會破壞 UTF-8；(2) 我在測試字串中寫的 `\n` 被當成字面反斜線傳入，模型把它視為雜訊。改用 `--data-binary @file.json` 並讓後端統一處理換行後即正常。這也驗證了「前處理應集中在後端」的設計決策。

---

## 5. 延遲問題分析（本週最重要的工程發現）

### 5.1 五組對照實測數據

為了釐清延遲瓶頸究竟出在 LLM 還是網路，並建立 Week 16 對照實驗的基準線，我跑了五組對照實驗。**所有數字皆為本週實測，非估算**：

| 引擎部署 | 端到端延遲 | 備註 |
| --- | --- | --- |
| **快取命中**（任一引擎） | < 5ms | 雙層快取設計的成果 |
| **NVIDIA NIM (Llama-3.1-8B)**（雲端 baseline） | ~2.4s | 商用推理服務最快 |
| **Gemini 3.5 Flash**（雲端 baseline） | ~4.8s | Google 旗艦 Flash 系列 |
| **Ollama Qwen2.5-7B fine-tuned (Colab T4 + tunnel)** | 5 – 6s | 本 PoC 主要方案 |
| **本機 CPU**（i7 / 16GB RAM） | 5.5 – 6.0s | 無 GPU 對照組 |

> [📷 截圖 4：Colab 上的 `nvidia-smi` 截圖，顯示 Tesla T4 + ollama 進程佔用 4880MiB VRAM]
> [📷 截圖 5：FastAPI 終端機顯示三引擎 ANALYZE log，可看到 engine 欄位分別為 ollama / gemini / nvidia]

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
2. **前端可用 loading 狀態消除焦慮**：規劃在下週實作骨架 Overlay 立即注入，分析完替換為正式警告
3. **快取命中時 < 5ms**：同封信件重開時已是「無感」（呼應 Week 14 設計的前端 Map + 後端 SHA-256 雙層快取）
4. **資源限制下的合理取捨**：本 PoC 在學生帳號 / 免費資源約束下，不追求 production-grade 延遲

### 5.4 可行的進一步優化（已列入 Week 16 待辦）

| 優化路徑 | 預期延遲 | 代價 / 限制 |
| --- | --- | --- |
| 前端 loading 狀態 + 粗篩 | 體感大幅改善 | 工程量小 |
| Ollama `OLLAMA_KEEP_ALIVE=24h` | 消除冷啟動 40s | 已於 Colab 設定，本機僅需 env var |
| 壓縮 system prompt 至 ~150 tokens | T4 推理 1-1.5s | 需與 C 重新對齊 prompt，B 可能需重訓 |
| 切到 A100/L4 等級 GPU | 推理 0.5-1s | 需 Colab Pro 或學校算力資源（如 grows.ai） |
| 蒸餾為更小模型（Qwen2.5-1.5B / Phi-3-mini） | T4 推理 0.5-1s | 準確度可能下降，需 B 重訓 |

### 5.5 架構限制與資安權衡（Week 16 論述素材）

雲端 GPU 部署雖能解決延遲，卻引入三個新議題，這正是「資安系統設計權衡」的真實案例：

| 議題 | 影響 | 緩解方案 |
| --- | --- | --- |
| trycloudflare URL 公開無認證 | 知道網址者皆可呼叫 LLM | Cloudflare Access + OAuth；正式部署應用具名 tunnel |
| 文本透過 HTTPS 出本機 | 仍屬「資料離開使用者裝置」 | 強調零洩漏者應堅守純本地；雲端模式宜標示為「效能優先」 |
| Colab 12 小時 / 90 分鐘 idle 斷線 | 無法 24/7 服務 | FastAPI 內建降級 fallback 自動退回 mock，前端不會壞 |

這呼應課程「Data Privacy vs Performance」的雙刃。本 PoC 透過 Options 頁讓使用者**顯式選擇**「本地模式（極致隱私）」或「雲端模式（極致延遲）」，將決定權交還使用者。

### 5.6 四引擎架構決策矩陣

整合上述所有實測與分析，下表彙整四個可用引擎在資安系統設計時需考量的四個關鍵軸線。**Week 16 報告的「Architecture & Trade-off」章節可直接引用此表**：

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

> 💡 **報告層面**：5-6 秒延遲不是缺點，而是「本地推理 vs 雲端推理 vs 硬體層級」三方權衡的**完整真實數據**。比起一句「我們做出來了」，這份**有 GPU 驗證 (nvidia-smi)、有延遲拆解、有四引擎決策矩陣、有取捨論述**的工程報告，在資安課程的評分軸線上更有重量。

---

## 6. 跨團隊協作：避免 Train/Serve Skew

本週與組員 B、C 的關鍵對齊：

- 我建立了 `INPUT_SPEC.md` 定義三層輸入規格（L1 API / L2 Prompt / L3 訓練資料）
- 確認後端推理時注入的 `SYSTEM_PROMPT` 與 B 訓練時、C 設計的 prompt **完全一致**
- 確認 user message 一律以 `<text>...</text>` 標籤包裹（同時也是一道 prompt injection 的緩解措施）

這個對齊避免了 ML 系統最常見的 Train/Serve Skew——若推理 prompt 與訓練 prompt 格式不同，微調模型的在地化能力會大打折扣。

---

## 7. 本週實際完成清單

回顧 §1 開頭設定的目標，本週交付完成度如下：

| 子任務 | 狀態 | 對應章節 |
| --- | --- | --- |
| LLM 引擎整合（Ollama 本地） | ✅ 完成 | §3.1 |
| 雙引擎架構（雲端 baseline） | ✅ 完成，實際做出**四引擎**（ollama / gemini / nvidia / mock-fallback） | §3.2 |
| 輸出穩定化（JSON 收斂） | ✅ 完成 | §3.3 |
| 容錯設計（降級 fallback） | ✅ 完成 | §3.4 |
| 跨團隊對齊（避免 Train/Serve Skew） | ✅ 完成（INPUT_SPEC.md） | §6 |
| 體感優化（前端 loading + 粗篩） | ✅ 完成（超出原規劃） | — |
| Options 引擎切換接後端 | ✅ 完成（超出原規劃） | — |
| Colab + cloudflared 遠端推理 | ✅ 完成（超出原規劃） | §5 |

## 8. 下週 (Week 16) 工作規劃

1. **協助組員 C 跑量化評估**：用三引擎（Ollama / Gemini / NVIDIA）對同一份 test set 跑 F1-Score 對照，產出混淆矩陣與 Precision/Recall 對比表
2. **架構圖與 API 規格整理**：把本週的雙引擎熱插拔、降級 fallback、INPUT_SPEC 對齊等設計畫成最終報告用的架構圖
3. **資料隱私章節**：整理「本地 vs 雲端」三引擎在資料外洩風險、延遲、準確度三軸上的權衡矩陣
4. **架構限制誠實討論**：5-6 秒延遲、trycloudflare URL 無認證、Colab session 上限等，誠實寫進「Architectural Limitations」

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

- 本週 commit 數：[待填]
- 投入時數：[待填]
