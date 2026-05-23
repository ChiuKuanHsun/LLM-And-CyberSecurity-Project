# Backend — FastAPI 中繼站

## 啟動方式

```powershell
# 1. 在專案根目錄建 venv
python -m venv .venv
.\.venv\Scripts\Activate.ps1

# 2. 安裝依賴
pip install -r backend/requirements.txt

# 3. 啟動伺服器（會在 http://127.0.0.1:8080）
cd backend
uvicorn main:app --reload
```

啟動後可造訪：

- `http://127.0.0.1:8080/docs` — Swagger UI，可直接測試 `/analyze`
- `http://127.0.0.1:8080/health` — Health check

## API 規格（與組員 B、C 對齊的契約）

### POST /analyze

Request:
```json
{
  "text": "您的蝦皮帳戶異常，請於兩小時內驗證身分",
  "source_url": "https://mail.google.com/...",
  "lang": "zh-TW"
}
```

Response:
```json
{
  "is_phishing": true,
  "risk_level": "High",
  "detected_intents": ["Urgency", "Authority"],
  "explanation": "偵測到2種社交工程意圖...",
  "latency_ms": 3,
  "engine": "mock-keyword-v1",
  "cache_hit": false
}
```

### 欄位意義

| 欄位 | 型別 | 說明 |
|---|---|---|
| `is_phishing` | bool | 是否為釣魚訊息 |
| `risk_level` | "High" / "Medium" / "Low" | 風險等級（前端 UI 顏色依據） |
| `detected_intents` | list | 從 4 大意圖中挑選（Urgency / Authority / Financial / Greed / None） |
| `explanation` | string | 繁體中文白話解釋，<= 50 字 |
| `latency_ms` | int | 後端處理時間，供 Week 15 延遲分析 |
| `engine` | string | 實際呼叫的引擎，便於對照實驗 |
| `cache_hit` | bool | 是否命中快取 |

## Week 進度

- **Week 14**：Mock keyword matcher，提供穩定 JSON schema 給前端串接
- **Week 15**：切換為組員 C 的 Prompt + OpenAI / Ollama 真實呼叫
- **Week 16**：補上 Baseline (OpenAI) 與 Fine-tuned (Ollama) 切換邏輯
