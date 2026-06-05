# INPUT_SPEC.md — 模型輸入規格與隊友 B 微調指南

> **這份文件是團隊三人對齊用的「契約文件」。**
> 任何修改都應於團隊群組同步，並更新版本號。
>
> **版本**：v1.0 — 2026-05-29（已凍結，Week 15 實作完成版）
> **維護**：組員 A（前端與整合）／ 組員 C（Prompt）／ 組員 B（資料與微調）共同維護
> **對應實作**：`backend/llm_engine.py`、`Modelfile`、HuggingFace `BuddyLu/phishing-qwen-gguf`

---

## 0. 為什麼需要這份文件？

LLM 系統最容易出問題的地方是 **Train/Serve Skew**（訓練時看到的格式與推理時看到的格式不一致），會造成微調模型在內測完美、實際擴充功能上線後表現腰斬。

為避免此問題，本專案定義三層「輸入」並分配責任：

| 層級 | 名稱 | 範圍 | 主責 |
| --- | --- | --- | --- |
| **L1** | API 輸入 | FastAPI `/analyze` 接收的 JSON | A |
| **L2** | LLM Prompt 輸入 | 真正餵給 LLM 的 system+user 字串 | C |
| **L3** | 訓練資料輸入 | LoRA 微調用的 JSONL dataset | B（須對齊 L2） |

**核心約束**：**L3 訓練樣本中模型實際看到的 user content，必須與 L2 推理時模型看到的完全一致。**

---

## 1. L1 — API 輸入（A 自定，純內部介面）

**Request schema**（`POST /analyze`）：

```json
{
  "text": "<擷取自網頁的純文本>",
  "source_url": "<分頁 URL，供除錯與快取 key>",
  "lang": "zh-TW",
  "engine": "ollama"
}
```

| 欄位 | 型別 | 必填 | 說明 |
| --- | --- | --- | --- |
| `text` | string | ✅ | 1–20000 字。前端已做過 HTML / 空白清洗 |
| `source_url` | string | ⬜ | 來源 URL（不會傳給 LLM，僅入 log） |
| `lang` | string | ⬜ | 預設 `zh-TW`，未來可支援多語 |
| `engine` | string | ⬜ | `ollama` / `gemini` / `nvidia` / `mock`，未填則用後端 `DEFAULT_ENGINE` |

**Response schema**：

```json
{
  "is_phishing": true,
  "risk_level": "High",
  "detected_intents": ["Urgency", "Authority"],
  "explanation": "假冒蝦皮客服並製造急迫感。",
  "latency_ms": 2455,
  "engine": "ollama:phishing-detector",
  "cache_hit": false
}
```

| 欄位 | 型別 | 說明 |
| --- | --- | --- |
| `is_phishing` | bool | 是否為釣魚 |
| `risk_level` | string | `High` / `Medium` / `Low` |
| `detected_intents` | string[] | 命中的意圖標籤（值域見 §2.1） |
| `explanation` | string | 繁中白話解釋，<= 50 字 |
| `latency_ms` | int | 端到端後端處理時間（含 LLM 呼叫） |
| `engine` | string | 實際使用的引擎標籤，如 `ollama:phishing-detector`、`gemini:gemini-3.5-flash`、`mock-fallback (原因: ConnectError)` |
| `cache_hit` | bool | 是否命中 SHA-256(engine‖text) 快取 |

B 與 C 不需要直接呼叫此 endpoint，僅供前端使用。

---

## 2. L2 — LLM Prompt 輸入（C 主責，**B 必須對齊**）

### 2.1 System Prompt（**v1.0 凍結版**，四引擎共用）

> ✅ **狀態**：已凍結。本內容同時存在於 `Modelfile`（Ollama 啟動時注入）與 `backend/llm_engine.py::SYSTEM_PROMPT`（雲端引擎呼叫時注入）。任何修改必須同步三處。

```
你是一個進階的 SOC 資安意圖分析引擎。請分析使用者輸入的網頁／信件文本，找出潛藏的社交工程攻擊意圖。

【判斷邏輯】
不要只依賴網址特徵。請深層分析文本是否包含「製造急迫感」、「冒充權威」、「誘騙提供財務或登入資訊」、「貪婪誘惑」等社交工程意圖。

【意圖標籤定義】
- Urgency：製造時間壓力（如「24 小時內」「立即」「凍結」「逾期」）
- Authority：冒充權威或品牌(銀行、政府機關、知名電商、客服)
- Financial：要求金錢動作（匯款、購買點數、驗證信用卡）
- Greed：以誘惑利益吸引點擊（中獎、免費領取、紅包）
- None：未偵測到上述任一意圖

【風險等級規則】
- High：偵測到 ≥2 種意圖，或單一意圖+明顯詐騙特徵
- Medium：僅 1 種意圖、需謹慎判斷
- Low：未發現明顯意圖

【輸出格式】
必須且只能輸出純 JSON，欄位順序固定為：
{"is_phishing": boolean, "risk_level": "High"|"Medium"|"Low", "detected_intents": ["Urgency"|"Authority"|"Financial"|"Greed"|"None"], "explanation": "<繁體中文白話解釋，<= 50 字>"}
不可附加 markdown 程式碼框、不可有額外說明文字。
```

### 2.2 User Message 模板（固定，不可改）

```
<text>
{使用者擷取的網頁文本，已做 HTML 清洗}
</text>
```

**規則**：
- 用 `<text>` 標籤包裹，方便 LLM 與訓練樣本辨識邊界；同時作為 prompt injection 的輕度緩解
- `{...}` 內部不再加任何前後綴
- 文本前處理由**後端 (A)** 統一執行（去 HTML 標籤、合併空白、限制 5000 字）
- **四引擎共用同一模板**：本地 Ollama (Qwen2.5-7B fine-tuned)、雲端 Gemini 3.5 Flash、雲端 NVIDIA NIM (Llama-3.1-8B)、Mock fallback，確保對照實驗為「模型能力差異」而非「prompt 差異」

### 2.3 預期 Assistant 輸出範例

```json
{"is_phishing":true,"risk_level":"High","detected_intents":["Urgency","Authority"],"explanation":"假冒蝦皮客服並製造急迫感，極可能為釣魚詐騙。"}
```

### 2.4 後端輸出收斂（防 LLM 亂講話）

LLM 即使開啟 JSON mode 仍可能：包 markdown code fence、夾雜說明、填出規格外的標籤。`backend/llm_engine.py` 內 `normalize_result()` 提供兩道防線：

1. **`_extract_json()`**：先剝除 ` ```json ... ``` ` 外框，失敗則用正則抓第一個 `{...}` 區塊
2. **`normalize_result()`** 強制收斂：
   - `risk_level` 不在白名單就降級為 `Low`
   - `detected_intents` 過濾非法標籤，若全空則填 `["None"]`
   - `explanation` 截斷至 80 字
   - `is_phishing` 強制為 bool

這確保**無論 LLM 輸出多離譜，前端拿到的永遠是合法的 `AnalyzeResponse`**，不會因模型抽風而崩潰。

---

## 3. L3 — 訓練資料格式（B 主責）

### 3.1 JSONL 格式（每行一筆完整對話）

```jsonl
{"messages": [{"role": "system", "content": "<§2.1 完整 system prompt>"}, {"role": "user", "content": "<text>\n您的蝦皮帳戶因異常登入已被限制，請於兩小時內點擊連結完成驗證身分\n</text>"}, {"role": "assistant", "content": "{\"is_phishing\":true,\"risk_level\":\"High\",\"detected_intents\":[\"Urgency\",\"Authority\"],\"explanation\":\"假冒蝦皮客服並製造急迫感，極可能為釣魚詐騙。\"}"}]}
```

### 3.2 五筆參考樣本（B 可直接複製當作起跑點）

```jsonl
{"messages": [{"role": "system", "content": "<§2.1 system prompt>"}, {"role": "user", "content": "<text>\n親愛的客戶，您的蝦皮帳戶因異常登入已被限制。請於兩小時內點擊以下連結完成驗證，否則將永久停權。\n</text>"}, {"role": "assistant", "content": "{\"is_phishing\":true,\"risk_level\":\"High\",\"detected_intents\":[\"Urgency\",\"Authority\"],\"explanation\":\"假冒蝦皮客服並用兩小時內停權製造急迫感，為釣魚詐騙。\"}"}]}
{"messages": [{"role": "system", "content": "<§2.1 system prompt>"}, {"role": "user", "content": "<text>\n【健保署通知】您的健保卡因資料異常即將失效，請立即點擊連結重新驗證身分證字號與信用卡資料以更新。\n</text>"}, {"role": "assistant", "content": "{\"is_phishing\":true,\"risk_level\":\"High\",\"detected_intents\":[\"Authority\",\"Urgency\",\"Financial\"],\"explanation\":\"假冒健保署索取信用卡資料，明顯詐騙。\"}"}]}
{"messages": [{"role": "system", "content": "<§2.1 system prompt>"}, {"role": "user", "content": "<text>\n恭喜您獲得 LINE Pay 抽獎活動 NT$5000 紅包！請於今日 23:59 前點擊連結並登入帳號領取，逾時失效。\n</text>"}, {"role": "assistant", "content": "{\"is_phishing\":true,\"risk_level\":\"High\",\"detected_intents\":[\"Greed\",\"Authority\",\"Urgency\"],\"explanation\":\"以中獎名義誘騙登入 LINE Pay，典型釣魚手法。\"}"}]}
{"messages": [{"role": "system", "content": "<§2.1 system prompt>"}, {"role": "user", "content": "<text>\n您的中華郵政包裹因地址資料不全，請於 24 小時內點擊以下連結補件並支付 NT$60 重新派送費，否則將退回。\n</text>"}, {"role": "assistant", "content": "{\"is_phishing\":true,\"risk_level\":\"High\",\"detected_intents\":[\"Authority\",\"Urgency\",\"Financial\"],\"explanation\":\"假冒中華郵政誘騙小額付款，為常見包裹詐騙。\"}"}]}
{"messages": [{"role": "system", "content": "<§2.1 system prompt>"}, {"role": "user", "content": "<text>\n各位同仁，下週三 14:00 在會議室 A 進行季度檢討，請帶筆電與 Q1 報表，謝謝。\n</text>"}, {"role": "assistant", "content": "{\"is_phishing\":false,\"risk_level\":\"Low\",\"detected_intents\":[\"None\"],\"explanation\":\"正常的內部會議通知，無社交工程跡象。\"}"}]}
```

### 3.3 資料集驗證腳本（B 開始收集前先建好）

```python
# validate_dataset.py
import json, sys

REQUIRED_INTENTS = {"Urgency", "Authority", "Financial", "Greed", "None"}
REQUIRED_RISK = {"High", "Medium", "Low"}

def validate(path):
    errors = []
    with open(path, encoding="utf-8") as f:
        for i, line in enumerate(f, 1):
            try:
                row = json.loads(line)
                msgs = row["messages"]
                assert len(msgs) == 3
                assert msgs[0]["role"] == "system"
                assert msgs[1]["role"] == "user"
                assert msgs[2]["role"] == "assistant"
                assert "<text>" in msgs[1]["content"] and "</text>" in msgs[1]["content"]
                out = json.loads(msgs[2]["content"])
                assert out["risk_level"] in REQUIRED_RISK
                assert all(t in REQUIRED_INTENTS for t in out["detected_intents"])
                assert len(out["explanation"]) <= 50
            except Exception as e:
                errors.append(f"Line {i}: {e}")
    print(f"Validated {i} samples, {len(errors)} errors")
    for e in errors[:10]:
        print("  " + e)

if __name__ == "__main__":
    validate(sys.argv[1])
```

---

## 4. B 的完整工作流程

### Step 1：資料收集（目標 500–1000 筆）

| 類別 | 比例 | 來源建議 |
| --- | --- | --- |
| **台灣在地化釣魚樣本** | 60–70% | 165反詐專線公告、警政署案例庫、PTT MobileComm 詐騙板、自製改寫（蝦皮／健保署／中華郵政／LINE Pay／中華電信／勞保局） |
| **英文釣魚樣本（翻譯改寫）** | 10–15% | PhishTank、Nazario Phishing Corpus、Enron Email Dataset 中含釣魚的子集 |
| **正常信件（Negative samples）** | 20–30% | 個人 Gmail 匿名化、公開 Enron 正常信件、新聞稿、公司行銷信、會議通知 |

> 💡 低於 500 筆 → LoRA 容易 overfit；超過 1000 筆 → Colab 免費版 GPU 時間吃緊。

### Step 2：標註（每筆人工貼標）

依 §3.1 格式產出 JSONL。建議先用 Excel／Google Sheet 標 `text / is_phishing / risk_level / detected_intents / explanation`，最後用 Python 一鍵轉成 JSONL。

### Step 3：資料切分

| 集合 | 比例 | 用途 |
| --- | --- | --- |
| Train | 80% | LoRA 微調 |
| Validation | 10% | 訓練中監控 loss、early stopping |
| Test | 10% | **由組員 C 保管**，訓練完才解封跑混淆矩陣 |

### Step 4：基底模型選擇

| 模型 | 大小 | 中文 | VRAM | 是否需審批 | 採用狀態 |
| --- | --- | --- | --- | --- | --- |
| TAIDE-LX-7B-Chat | 7B | ⭐⭐⭐⭐⭐ | ~10GB | 需申請 | 申請時程不允許，未採用 |
| Llama-3.1-8B-Instruct | 8B | ⭐⭐⭐ | ~10GB | 需 Meta 批准 | 採作雲端 baseline（NVIDIA NIM 托管） |
| **Qwen2.5-7B-Instruct** | 7B | ⭐⭐⭐⭐ | ~10GB | **無需審批** | ✅ **本 PoC 實際採用** |
| Phi-3-mini-4B | 4B | ⭐⭐ | ~6GB | 無需審批 | Colab 免費版友善的備案 |

→ **實際採用 Qwen2.5-7B-Instruct**。TAIDE 因申請時程考量未採用；Qwen2.5-7B 中文能力對在地化釣魚分類已綽綽有餘，且 Apache 2.0 授權更利於後續開源。微調後的 GGUF 已公開於 [BuddyLu/phishing-qwen-gguf](https://huggingface.co/BuddyLu/phishing-qwen-gguf/tree/main)。

### Step 5：訓練（Google Colab）

```
HuggingFace Datasets        # 載入 JSONL
       ↓
Unsloth (PEFT + LoRA)       # 比原生 TRL 快 2-5x，省 VRAM
       ↓
SFTTrainer                  # Supervised Fine-Tuning
       ↓
4-bit quantization (bnb)    # T4 (16GB) 跑得動 7B 模型
       ↓
LoRA adapter (.safetensors) # ~50MB
       ↓
merge + convert to GGUF     # Unsloth.save_pretrained_gguf
       ↓
GGUF Q4_K_M (~4GB)          # 最終產物，給 Ollama 用
```

**超參數建議**（給 B 起跑點）：

| 超參 | 值 | 備註 |
| --- | --- | --- |
| LoRA rank `r` | 16 | 太大會 overfit，太小學不到 |
| LoRA alpha | 32 | 通常設 `r` 的 2 倍 |
| Learning rate | 2e-4 | LoRA 標準範圍 1e-4 ~ 5e-4 |
| Batch size | 2 (per device) | T4 上 7B + 4-bit 大約這個量 |
| Gradient accumulation | 4 | effective batch = 8 |
| Epochs | 3 | 配合 early stopping |
| Max seq length | 2048 | 我們的文本最長 5000 字，截斷可接受 |

### Step 6：產出物清單（v1.0 實際交付）

| # | 檔案 | 大小 | 狀態 |
| --- | --- | --- | --- |
| 1 | **`Qwen2.5-7B-Instruct.Q4_K_M.gguf`** | 4.7 GB | ✅ 已交付，並上傳至 [HuggingFace](https://huggingface.co/BuddyLu/phishing-qwen-gguf/tree/main) |
| 2 | **`Modelfile`** | < 1 KB | ✅ 已交付（A 補上 SYSTEM 與 temperature 參數） |
| 3 | `training_log.json` / Loss 曲線截圖 | — | ⏳ 報告 §3.3 使用 |
| 4 | `dataset_stats.md`（資料分布統計） | — | ⏳ 報告 §3.3 使用 |
| 5 | Held-out test set JSONL（由 C 保管） | — | ⏳ 報告 §5 評估使用 |

### Step 7：交付 A，A 整合進四引擎架構

A 收到 `.gguf` 後（或直接從 HF 拉）：

```powershell
# 方法 A：HF 直接拉（推薦）
ollama pull hf.co/BuddyLu/phishing-qwen-gguf
ollama create phishing-detector -f Modelfile

# 方法 B：本地 .gguf + Modelfile
ollama create phishing-detector -f Modelfile
```

A 已將整合抽象為 `backend/llm_engine.py`，本地 Ollama 與 雲端 Gemini / NVIDIA NIM 共用同一 `SYSTEM_PROMPT` 與 `build_user_message()`。前端 Options 頁可即時切換四引擎，後端 `/analyze` 接收 `engine` 參數路由至對應 `call_*()` 函式。完整介接點：

```python
async def analyze_with_engine(text, engine=None):
    engine = (engine or DEFAULT_ENGINE).lower()
    if engine == "ollama": return await call_ollama(text), f"ollama:{OLLAMA_MODEL}"
    if engine == "gemini": return await call_gemini(text), f"gemini:{GEMINI_MODEL}"
    if engine == "nvidia": return await call_nvidia(text), f"nvidia:{NVIDIA_MODEL}"
```

整個 API 介面不變（同一個 prompt template、同一個 JSON schema），實現**四引擎熱插拔**。

---

## 5. 給 B 與 C 的期末報告素材檢查清單

### B 負責（資料與微調章節）

- [ ] 資料集分布圓餅圖（4 大意圖各佔多少）
- [ ] 訓練 Loss 曲線截圖（Unsloth 自動產生 → `report/final/figs/loss_curve.png`）
- [ ] 至少一張「踩坑紀錄」（OOM？資料品質？4-bit 量化精度？）
- [ ] LoRA rank ablation 表格（如果時間允許跑 r=8/16/32 對比）
- [ ] GGUF 模型大小 vs 推理速度對比表
- [ ] 將 Modelfile + GGUF 上傳到 HF（已完成 ✅）

### C 負責（Prompt 與評估章節）

- [ ] Held-out test set 組成統計
- [ ] 五引擎對照：Ollama fine-tuned / Qwen base / Gemini / NVIDIA NIM / Mock 的 F1 / Precision / Recall / Accuracy
- [ ] 混淆矩陣（`report/final/figs/confusion_matrix.png`）
- [ ] False Positive / False Negative 案例深度分析（2-3 個）
- [ ] Prompt 迭代軌跡（v0 → v1 → v2 為何修改）

---

## 6. 變更紀錄 (Changelog)

| 版本 | 日期 | 變更 | 提案人 |
| --- | --- | --- | --- |
| v0.1 | 2026-05-24 | 初版發布，定義 L1/L2/L3 三層輸入 | A |
| **v1.0** | **2026-05-29** | **凍結版：(1) L1 加 `engine` 欄位 + 完整 Response schema；(2) §2.1 system prompt 凍結，標明 Modelfile 與 `llm_engine.py` 雙處同步；(3) 新增 §2.4 後端輸出收斂（normalize_result 兩道防線）；(4) §2.2 從「雙引擎共用」更新為「四引擎共用」（Ollama / Gemini / NVIDIA / Mock）；(5) §4 Step 4 採用模型由 TAIDE 改為實際採用的 Qwen2.5-7B-Instruct；(6) §4 Step 6 交付物含 HF URL；(7) §4 Step 7 補上 `llm_engine.py` 路由實作；(8) §5 檢查清單拆 B/C 兩半，雲端 baseline 改 Gemini + NVIDIA。** | A |
