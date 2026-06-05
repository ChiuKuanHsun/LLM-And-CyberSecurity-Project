# Colab 反向代理：把 Ollama 部署到 Colab GPU

## 為什麼這樣做？

本地 CPU 跑 Qwen2.5-7B Q4_K_M 每次推理約 5~6 秒。Colab Free 的 T4 GPU (16GB VRAM) 可壓到 **0.5~1 秒**，差距 6~12 倍。

## 架構

```
[Chrome Extension] ──▶ [本機 FastAPI :8080] ──HTTPS──▶ [Colab Ollama]
                                                       │
                                                       └─ trycloudflare URL
```

**只有 Ollama 部署到雲端**，FastAPI 留在本機保留快取、降級 fallback、Pydantic 驗證等好處。

---

## Step 1：準備 Google Drive 檔案（只做一次）

把以下兩個檔案上傳到 Google Drive 的 `MyDrive/llm_phishing/`：

- `Qwen2.5-7B-Instruct.Q4_K_M.gguf`（4.6GB）
- `Modelfile`

> 💡 上傳 .gguf 走 Google Drive 桌面同步 App 最穩，網頁直傳容易斷線

---

## Step 2：Colab Notebook（逐 cell 貼上執行）

新增一個 Colab notebook，**Runtime → Change runtime type → T4 GPU**，然後依序貼上下列 cell。

### Cell 1 — 安裝 Ollama 並啟動

```python
!curl -fsSL https://ollama.com/install.sh | sh

import subprocess, time, os
os.environ["OLLAMA_HOST"] = "0.0.0.0:11434"
os.environ["OLLAMA_KEEP_ALIVE"] = "24h"   # 模型常駐記憶體，消除冷啟動

# 在背景啟動 ollama serve
proc = subprocess.Popen(
    ["ollama", "serve"],
    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    env=os.environ,
)
time.sleep(5)
!ollama --version
```

### Cell 2 — 掛載 Google Drive

```python
from google.colab import drive
drive.mount('/content/drive')

GGUF_DIR = "/content/drive/MyDrive/llm_phishing"
!ls -lh "$GGUF_DIR"
```

確認列出 `.gguf` 與 `Modelfile`。

### Cell 3 — 建立 Ollama 模型

```python
# 因為 Modelfile 內的 FROM 是相對路徑 ./Qwen2.5-...gguf，要在該目錄下執行
%cd $GGUF_DIR
!ollama create phishing-detector -f Modelfile
!ollama list
```

預期看到 `phishing-detector` 列在其中。第一次 create 會花 1~2 分鐘把 gguf 載入。

### Cell 4 — 啟動 cloudflared tunnel

```python
import subprocess, re, time, sys

# 下載 cloudflared
!wget -q https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 -O /usr/local/bin/cloudflared
!chmod +x /usr/local/bin/cloudflared

# 開 quick tunnel 指向本機 Ollama (port 11434)
tunnel = subprocess.Popen(
    ["cloudflared", "tunnel", "--url", "http://127.0.0.1:11434",
     "--no-autoupdate", "--metrics", "127.0.0.1:0"],
    stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
)

# 從 stdout 抓出分配到的 URL
public_url = None
for _ in range(120):
    line = tunnel.stdout.readline()
    if not line:
        time.sleep(0.5); continue
    print(line.rstrip())
    m = re.search(r"https://[a-z0-9-]+\.trycloudflare\.com", line)
    if m:
        public_url = m.group(0); break

print("\n" + "=" * 60)
print("🚀 你的 Ollama 公開 URL：")
print(public_url)
print("=" * 60)
print("\n本機 PowerShell 設定：")
print(f'  $env:OLLAMA_HOST = "{public_url}"')
```

✅ 預期看到類似：`https://abcdef-xyz-1234.trycloudflare.com`

### Cell 5 — Smoke test（驗證模型在 Colab 跑得動）

```python
import requests, json, time

t0 = time.perf_counter()
r = requests.post(
    f"{public_url}/api/chat",
    json={
        "model": "phishing-detector",
        "messages": [{
            "role": "user",
            "content": "<text>\n您的蝦皮帳戶因異常登入已被限制，請於兩小時內驗證\n</text>"
        }],
        "stream": False,
        "format": "json",
        "options": {"temperature": 0.1},
    },
    timeout=120,
)
elapsed = time.perf_counter() - t0

print(f"延遲：{elapsed*1000:.0f} ms")
print("輸出：")
print(json.dumps(r.json()["message"], ensure_ascii=False, indent=2))
```

預期延遲 < 2 秒（首次含載入時間，第二次以後 < 1 秒）。

---

## Step 3：本機切換到 Colab Ollama

把 Cell 4 印出的 URL 套到 FastAPI：

```powershell
# PowerShell — 設環境變數後重啟 uvicorn
$env:OLLAMA_HOST = "https://abcdef-xyz-1234.trycloudflare.com"
$env:DEFAULT_ENGINE = "ollama"
$env:OLLAMA_MODEL = "phishing-detector"

cd backend
.\.venv\Scripts\Activate.ps1
python -m uvicorn main:app --host 127.0.0.1 --port 8080 --reload
```

驗證後端確實打到 Colab：

```powershell
curl http://127.0.0.1:8080/health
# 預期回 {"status":"ok","version":"0.2.0-week15","default_engine":"ollama"}
```

然後在 Gmail 上開啟一封測試信，Overlay 應該在 1-2 秒內彈出。

---

## 注意事項與限制（這些是 Week 16 報告素材）

| 項目 | 說明 |
|---|---|
| **Tunnel URL 每次不同** | cloudflared quick tunnel 每次都會分配新網址，session 重啟要更新本機 env var |
| **Colab 90 分鐘 idle 斷線** | 沒互動會被回收，要保持頁面活躍或寫 keep-alive ping |
| **Free Colab 12 小時上限** | 連續使用上限，但對課程 PoC 已綽綽有餘 |
| **無認證** | trycloudflare URL 是公開的，知道網址的人都能打。**正式部署應用 cloudflared tunnel + Cloudflare Access** |
| **頻寬** | cloudflared free tier 沒有明確上限，但避免大量請求 |

---

## Kaggle 替代方案

Kaggle Notebooks 也能跑（T4 x2 或 P100 比 Colab 更快），但 cloudflared 啟動方式相同。差別：

- Kaggle 每週 30 小時 GPU 配額（Colab 是動態）
- Kaggle 介面較陽春，但更少 idle disconnect

如果 Colab quota 用完可切 Kaggle 同樣的 cell 內容。

---

## 進一步優化（可選）

### 跳過 cold start

`OLLAMA_KEEP_ALIVE=24h` 已在 Cell 1 設定，模型會常駐 GPU 直到 session 結束，徹底消除冷啟動。

### 顯示 GPU 使用率

```python
!nvidia-smi
```

Qwen2.5-7B Q4_K_M 大約佔 5~6GB VRAM，T4 16GB 有充足空間。

### 如果想連 FastAPI 也搬到 Colab（方案 A）

只要把 `cloudflared tunnel --url http://127.0.0.1:11434` 改成 `http://127.0.0.1:8080`，並在 Colab 內啟動 FastAPI 即可。但這樣會喪失本地降級、本地快取的好處，**不推薦**。
