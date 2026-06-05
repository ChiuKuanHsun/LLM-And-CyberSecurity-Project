# 🛡 Intent-Based Phishing Detector

> **LLM 意圖導向防釣魚 Chrome 擴充功能** — 以 LLM 即時分析網頁文本背後的社交工程攻擊意圖，偵測「武器化文本 (weaponized text)」型態的釣魚攻擊。

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Python 3.10+](https://img.shields.io/badge/Python-3.10+-blue.svg)](https://www.python.org/)
[![Chrome MV3](https://img.shields.io/badge/Chrome-Manifest_V3-4285F4.svg)](https://developer.chrome.com/docs/extensions/develop/migrate)
[![Course](https://img.shields.io/badge/Course-LLM_Applications_in_Cybersecurity-9b59b6.svg)](#)

---

## 🔗 Quick Links

| 資源 | 連結 |
| --- | --- |
| 🎥 **操作演示影片** | [YouTube — TODO: 貼上連結](https://youtube.com/watch?v=TODO) |
| 🤗 **微調模型 (GGUF)** | [BuddyLu/phishing-qwen-gguf on Hugging Face](https://huggingface.co/BuddyLu/phishing-qwen-gguf/tree/main) |
| 📄 **期末整合報告 (LaTeX)** | [`report/final/main.tex`](report/final/main.tex) |
| 📋 **三層輸入規格** | [`INPUT_SPEC.md`](INPUT_SPEC.md) |
| ☁️ **Colab 雲端 GPU 部署指南** | [`colab/README.md`](colab/README.md) |

---

## 📑 目錄

- [專案動機](#-專案動機)
- [核心特色](#-核心特色)
- [系統架構](#-系統架構)
- [快速開始](#-快速開始-3-步)
- [詳細安裝步驟](#-詳細安裝步驟)
- [使用說明](#-使用說明)
- [專案結構](#-專案結構)
- [技術棧](#-技術棧)
- [實測延遲數據](#-實測延遲數據)
- [團隊與分工](#-團隊與分工)
- [致謝與授權](#-致謝與授權)

---

## 🎯 專案動機

近年釣魚攻擊已從早期單純的「惡意連結」演化為高度社交工程化的「武器化文本」。攻擊者可能不附任何可疑連結，僅以「您的健保卡將於 24 小時內失效」、「LINE Pay 中獎」等敘事誘騙使用者。傳統依賴 URL 黑名單與規則式關鍵字的反釣魚機制對此類**沒有可疑網址**的純文本社交工程幾乎失去防禦力。

呼應課程強調的典範轉移：

> *We shifted from rule-based signature detection to **dynamic behavioral / intent understanding**.*

本系統以 LLM 對自然語言的深層語意理解能力，建構「**意圖導向 (Intent-Based)**」的釣魚偵測，將焦點從「訊息含什麼字」改為「訊息背後想讓使用者做什麼」。

---

## ✨ 核心特色

- 🧠 **四引擎熱插拔**：本地 LoRA 微調 Qwen2.5-7B / 雲端 Gemini 3.5 Flash / 雲端 NVIDIA NIM / Mock 降級，使用者可於 Options 頁切換
- 🔒 **資料隱私可選**：本地模式資料 100% 留在本機，零外洩；雲端模式延遲更低（5 倍快）但文本會送第三方——權衡由使用者決定
- ⚡ **雙層快取**：前端 Map + 後端 SHA-256，同訊息重看 < 5ms
- 🛡 **降級 Fallback**：LLM 服務全部斷線時自動退回 mock keyword 分類，前端永遠有結果
- 🇹🇼 **台灣在地化**：以 165 反詐專線、警政署案例、自製改寫的本土詐騙場景訓練（蝦皮、健保署、中華郵政、LINE Pay）
- 🔐 **最小特權設計**：MV3 Optional Permissions + 動態 Content Script 註冊，使用者可自訂掃描網站
- 📊 **完整可觀測性**：每筆請求記錄 engine、latency、cache_hit、降級原因

---

## 🏗 系統架構

```
┌────────────────────────────────────────────────────────────┐
│                      Browser                               │
│  ┌─────────────────────┐         ┌────────────────────┐    │
│  │  Content Script     │ ─msg→   │  Service Worker    │    │
│  │  • DOM 擷取         │         │  • 統一 fetch       │    │
│  │  • 粗篩 / 防分身    │         │  • 引擎路由         │    │
│  │  • Overlay 渲染     │ ←msg─   │  • 動態權限管理     │    │
│  └─────────────────────┘         └──────┬─────────────┘    │
└────────────────────────────────────────│───────────────────┘
                                         │ POST /analyze
                                         ▼
                       ┌──────────────────────────────────┐
                       │   FastAPI 中繼站 (127.0.0.1:8080) │
                       │   • Pydantic 驗證                  │
                       │   • (engine, text) SHA-256 快取    │
                       │   • 降級 fallback                  │
                       └────┬─────────┬─────────┬──────────┘
              ┌─────────────┘         │         └─────────────┐
              ▼                       ▼                       ▼
    ┌──────────────────┐ ┌──────────────────┐ ┌──────────────────┐
    │ Ollama 本地      │ │ Gemini 3.5 Flash │ │ NVIDIA NIM        │
    │ Qwen2.5-7B GGUF  │ │ (Google AI)      │ │ Llama-3.1-8B      │
    └──────────────────┘ └──────────────────┘ └──────────────────┘
              └────────────── 共用 SYSTEM_PROMPT ──────────────┘
```

詳細的引擎抽象層、降級 fallback、輸出收斂設計見 [`report/final/main.tex`](report/final/main.tex) §3。

---

## 🚀 快速開始 (3 步)

### Step 1 — Clone 並建立 venv

```powershell
git clone https://github.com/YOUR_USERNAME/intent-phishing-detector.git
cd intent-phishing-detector

python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r backend/requirements.txt
```

### Step 2 — 載入微調模型（兩種選擇擇一）

**方法 A：直接從 Hugging Face 拉取（推薦）**

```powershell
# Ollama 0.18+ 原生支援 hf.co/<user>/<repo> 路徑
ollama pull hf.co/BuddyLu/phishing-qwen-gguf:Q4_K_M

# 套用我們的 Modelfile（含 system prompt 與低溫度設定）
ollama create phishing-detector -f Modelfile
```

**方法 B：手動下載 GGUF**

到 [Hugging Face 模型頁](https://huggingface.co/BuddyLu/phishing-qwen-gguf/tree/main) 下載 `Qwen2.5-7B-Instruct.Q4_K_M.gguf`（約 4.7 GB），放到專案根目錄，然後：

```powershell
ollama create phishing-detector -f Modelfile
ollama list   # 應該看到 phishing-detector:latest
```

### Step 3 — 啟動後端 + 載入擴充功能

```powershell
# 啟動 FastAPI（會跑在 http://127.0.0.1:8080）
cd backend
python -m uvicorn main:app --host 127.0.0.1 --port 8080 --reload
```

另開一個視窗，把 `extension/` 資料夾載入 Chrome：

1. 開啟 Chrome → 網址列 `chrome://extensions/`
2. 右上角開啟「開發人員模式」
3. 點「載入未封裝項目」→ 選擇本專案的 `extension/` 資料夾

完成！打開 Gmail / Outlook 開啟任一信件，應該會看到分析中的灰色 banner，幾秒後變成綠色 ✓（正常）或紅色 ⚠️（釣魚）。

---

## 🔧 詳細安裝步驟

### 系統需求

| 元件 | 版本 |
| --- | --- |
| Python | 3.10+ |
| Chrome / Chromium | 122+ (MV3) |
| [Ollama](https://ollama.com) | 0.18+ |
| RAM | 16GB+（本地推理 7B 模型） |
| GPU（選用） | NVIDIA GPU 6GB+ VRAM，無 GPU 也能跑（CPU 推理較慢） |

### 後端 (FastAPI)

完整的後端啟動文件見 [`backend/README.md`](backend/README.md)。

可選環境變數：

```powershell
# 選擇預設引擎
$env:DEFAULT_ENGINE = "ollama"            # ollama | gemini | nvidia | mock

# Ollama 設定（預設本機）
$env:OLLAMA_HOST = "http://127.0.0.1:11434"
$env:OLLAMA_MODEL = "phishing-detector"

# 雲端 baseline（選用，僅在需要對照實驗時設定）
$env:GEMINI_API_KEY = "你的 Gemini API Key"   # https://aistudio.google.com
$env:GEMINI_MODEL = "gemini-3.5-flash"
$env:NVIDIA_API_KEY = "你的 NVIDIA NIM Key"   # https://build.nvidia.com
$env:NVIDIA_MODEL = "meta/llama-3.1-8b-instruct"
```

啟動後可造訪 `http://127.0.0.1:8080/docs` 看 Swagger UI 互動測試。

### Chrome 擴充功能

完整文件見 [`extension/README.md`](extension/README.md)。

關鍵設計：
- **Manifest V3** 採最小特權設計，內建支援 Gmail / Facebook / LINE
- **使用者自訂網站**：Options 頁可動態新增任意 webmail / 社群網站，授權後即生效
- **四引擎切換**：Options 頁可切換 Ollama / Gemini / NVIDIA / Mock

### 模型部署選項

#### Option 1 — 本機 GPU/CPU（推薦，零外洩）

依「快速開始」即可。本機推理延遲：

- 有 GPU：1-2 秒
- 純 CPU：5-6 秒

#### Option 2 — Colab T4 反向代理（GPU 不夠時的方案）

把 Ollama 部署到 Google Colab 免費 T4，本機 FastAPI 透過 cloudflared tunnel 呼叫。完整 5-cell notebook 見 [`colab/README.md`](colab/README.md)。

延遲約 5-6 秒（含跨太平洋網路 overhead）。

#### Option 3 — 雲端 baseline 對照

不想跑本地推理時，可直接使用 Gemini 或 NVIDIA NIM 免費 API：

- **Gemini 3.5 Flash**：~4.8s，免費層 10 RPM / 250 RPD
- **NVIDIA NIM (Llama-3.1-8B)**：~2.4s，免費額度充足

設好 API key 後在 Options 頁切換即可。

---

## 💡 使用說明

### 一般使用

1. 確保 FastAPI 後端在跑 (`http://127.0.0.1:8080/health` 應回 200 OK)
2. 開啟 Gmail / Outlook / Facebook / LINE Web 等支援站台
3. 開啟一封信件，幾秒後上方會出現：
   - 🟢 **綠色 banner**：未偵測到釣魚跡象
   - 🟡 **灰色 banner**：分析中（LLM 推理 2-6 秒）
   - 🟠 **橘色 banner**：Medium 風險，請謹慎
   - 🔴 **紅色 banner**：High 風險，極可能是釣魚

每個警告 banner 附上：
- 偵測到的攻擊意圖（Urgency / Authority / Financial / Greed）
- LLM 給出的白話解釋（繁中，<= 50 字）
- 使用的引擎與延遲

### 新增掃描網站

點擴充功能圖示 → ⚙️ 設定 → 「📌 自訂掃描網站」區塊輸入 URL 後按「＋ 新增」，Chrome 會跳出原生授權彈窗，允許後立即生效。

### 切換 LLM 引擎

設定頁的「LLM 引擎」區塊提供四個 radio 選項，按下「儲存」並重新整理頁面即可。可即時看到不同引擎的延遲差異。

### 工具列 Popup

點擴充功能圖示打開 popup：
- 顯示後端連線狀態
- 顯示目前選擇的引擎
- 一鍵加入「當前網站」到掃描清單

---

## 📂 專案結構

```
Project/
├── README.md                    # 本檔
├── INPUT_SPEC.md                # 三層輸入規格（跨團隊契約）
├── Modelfile                    # Ollama 模型定義（system prompt + 參數）
│
├── backend/                     # FastAPI 中繼站
│   ├── main.py                  #   • 引擎路由、Pydantic schema、快取、降級
│   ├── llm_engine.py            #   • Ollama / Gemini / NVIDIA 四引擎抽象層
│   ├── requirements.txt
│   └── README.md
│
├── extension/                   # Chrome Extension (Manifest V3)
│   ├── manifest.json            #   • 最小特權 + optional_host_permissions
│   ├── background.js            #   • Service Worker：fetch 統一管理
│   ├── content.js               #   • DOM 擷取、粗篩、防分身、Overlay 渲染
│   ├── overlay.css              #   • 警告 / Loading / Safe 三種視覺
│   ├── popup.html, popup.js     #   • 工具列：連線狀態 + 一鍵加入
│   ├── options/                 #   • 設定頁：引擎切換 + 自訂網站清單
│   │   ├── options.html
│   │   └── options.js
│   ├── icons/
│   └── README.md
│
├── colab/                       # Colab 雲端 GPU 部署
│   └── README.md                #   • 5-cell notebook + cloudflared tunnel
│
└── report/                      # 報告
    ├── Week14_組員A_個人報告.md  # Week 14 個人報告（MD）
    ├── Week15_組員A_個人報告.md  # Week 15 個人報告（MD）
    └── final/                   # Week 16 期末整合報告
        ├── main.tex             #   • LaTeX 主檔
        ├── references.bib       #   • 8 篇引用
        ├── README.md            #   • Overleaf 共編說明
        └── figs/
```

---

## 🛠 技術棧

### 前端
- **Chrome Extension** Manifest V3
- 原生 JavaScript（無 framework，極輕量）
- CSS3（spinner 動畫、響應式 Overlay）

### 後端
- **Python 3.10+** + **FastAPI** + **Uvicorn**
- Pydantic 2.x（schema 驗證）
- httpx（async HTTP client）

### LLM 引擎
- **本地**：[Ollama](https://ollama.com) + Qwen2.5-7B-Instruct (LoRA fine-tuned + Q4_K_M 量化)
- **微調工具**：[Unsloth](https://github.com/unslothai/unsloth) + PEFT (LoRA)
- **雲端 baseline**：Google Gemini API / NVIDIA NIM API

### 報告與文件
- **LaTeX** (XeLaTeX) + BibTeX
- **Markdown** for 個人報告與 README

---

## 📊 實測延遲數據

| 部署組合 | 端到端延遲 | 備註 |
| --- | --- | --- |
| 快取命中（任一引擎） | < 5 ms | 雙層快取 |
| NVIDIA NIM (Llama-3.1-8B) | ~ 2.4 s | 商用推理最快 |
| Gemini 3.5 Flash | ~ 4.8 s | Google Flash 系列 |
| Ollama 本地（有 GPU） | 1 - 3 s | 視 GPU 而定 |
| Ollama 本地（純 CPU, i7） | 5 - 6 s | 無 GPU 對照 |
| Ollama Colab T4 + cloudflared | 5 - 6 s | 含跨太平洋網路 |

更詳細的延遲構成與架構決策矩陣見 [期末報告 §6](report/final/main.tex)。


---

## 🎬 操作演示

📺 **YouTube 演示影片**：[https://youtube.com/watch?v=TODO](https://youtube.com/watch?v=TODO)

影片內容：
1. 載入擴充功能與啟動後端
2. 開啟 Gmail 上的詐騙信件，紅色警告 Overlay
3. 開啟正常信件，綠色 ✓ badge
4. 切換 LLM 引擎（Ollama → Gemini → NVIDIA），對比延遲與判斷
5. 新增 Outlook 到自訂掃描網站
6. 演示 Colab 反向代理部署

---

## 🤖 微調模型

我們的微調模型已開源於 Hugging Face：

🤗 **[BuddyLu/phishing-qwen-gguf](https://huggingface.co/BuddyLu/phishing-qwen-gguf/tree/main)**

- 基底模型：Qwen2.5-7B-Instruct
- 微調方法：LoRA (r=[TODO: B], α=[TODO: B])
- 訓練資料：[TODO: B] 筆台灣在地化釣魚樣本 + 正常信件
- 量化格式：GGUF Q4_K_M（4.7 GB）
- 框架：Unsloth + PEFT

直接用 Ollama 拉取：
```bash
ollama pull hf.co/BuddyLu/phishing-qwen-gguf
```

---

## 🙏 致謝與授權

### 致謝
- **課程教師與助教**：感謝指導與評分機會
- **Hugging Face / Ollama / Unsloth** 開源社群提供工具鏈
- **Google AI Studio / NVIDIA NIM** 提供免費 API 額度

### 授權
本專案為大學課程期末作業，僅供學術用途。

### 相關研究
本系統的設計呼應以下文獻與課程內容：
- Cialdini, *Influence: The Psychology of Persuasion*（社交工程心理學基礎）
- Hu et al., *LoRA: Low-Rank Adaptation of Large Language Models* (ICLR 2022)
- Khonji et al., *Phishing Detection: A Literature Survey* (IEEE CST 2013)
- Nielsen, *Usability Engineering*（Visibility of System Status 原則）

完整引用見 [`report/final/references.bib`](report/final/references.bib)。

---

<p align="center">
  <sub>Built with ❤️ by Team 59 — Spring 2026</sub><br/>
  <sub>「將 LLM 從不可控的黑盒，收束為可在生產環境信賴的元件。」</sub>
</p>
