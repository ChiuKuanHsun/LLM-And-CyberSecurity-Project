"""
Intent-Based Phishing Detector — FastAPI 中繼站
組員 A：前端與系統整合
Week 14：Mock 版本，提供穩定的 JSON Schema 給前端串接，
        Week 15 再切換成真實 LLM (OpenAI / Ollama) 呼叫。
"""
from __future__ import annotations

import hashlib
import logging
import time
from typing import Literal

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
)
logger = logging.getLogger("phishing-detector")

app = FastAPI(
    title="Intent-Based Phishing Detector API",
    description="LLM 意圖分析中繼站 — 接收網頁文本，回傳釣魚風險評估",
    version="0.1.0-week14",
)

# Chrome Extension 來源不固定（chrome-extension://<id>），開發階段先全開
# Week 16 報告需討論：正式部署應改為 chrome-extension://<發布後的固定ID>
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["POST", "GET", "OPTIONS"],
    allow_headers=["*"],
)


# ---------- Pydantic Schema：與組員 B / C 對齊的契約 ----------

ThreatIntent = Literal["Urgency", "Authority", "Financial", "Greed", "None"]
RiskLevel = Literal["High", "Medium", "Low"]


class AnalyzeRequest(BaseModel):
    text: str = Field(..., min_length=1, max_length=20000, description="網頁擷取的純文本")
    source_url: str | None = Field(None, description="文本來源 URL，用於除錯與快取 key")
    lang: str | None = Field("zh-TW", description="文本主要語言")


class AnalyzeResponse(BaseModel):
    is_phishing: bool
    risk_level: RiskLevel
    detected_intents: list[ThreatIntent]
    explanation: str = Field(..., description="繁體中文白話解釋，<= 50 字")
    latency_ms: int
    engine: str = Field(..., description="實際呼叫的 LLM 引擎名稱，方便 Week 15 對照實驗")
    cache_hit: bool = False


# ---------- 快取：避免重複分析相同網頁，降低 LLM 成本 ----------

_cache: dict[str, AnalyzeResponse] = {}


def _cache_key(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


# ---------- Mock 分類器：Week 14 暫用，Week 15 由組員 C 的 Prompt 取代 ----------

# 4 大威脅意圖關鍵字，依組員 C 的威脅模型定義
_INTENT_KEYWORDS: dict[ThreatIntent, list[str]] = {
    "Urgency":   ["立即", "限時", "24小時內", "兩小時內", "逾期", "盡快", "馬上", "停權", "凍結"],
    "Authority": ["客服", "官方", "銀行", "蝦皮", "健保署", "國稅局", "警政署", "LINE Pay", "郵局"],
    "Financial": ["匯款", "點數", "轉帳", "薪資", "退稅", "扣款", "信用卡", "驗證身分"],
    "Greed":     ["中獎", "免費", "領取", "禮品", "優惠", "紅包"],
}


def _mock_analyze(text: str) -> tuple[bool, RiskLevel, list[ThreatIntent], str]:
    """關鍵字計分 mock，僅供 Week 14 前端串接驗證。Week 15 換成真實 LLM。"""
    hits: list[ThreatIntent] = []
    for intent, keywords in _INTENT_KEYWORDS.items():
        if any(kw in text for kw in keywords):
            hits.append(intent)

    if len(hits) >= 2:
        return True, "High", hits, f"偵測到{len(hits)}種社交工程意圖（{', '.join(hits)}），高度疑似釣魚訊息。"
    if len(hits) == 1:
        return True, "Medium", hits, f"出現「{hits[0]}」類型語句，請謹慎判斷。"
    return False, "Low", ["None"], "未偵測到明顯的社交工程意圖。"


# ---------- API ----------

@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok", "version": app.version}


@app.post("/analyze", response_model=AnalyzeResponse)
def analyze(req: AnalyzeRequest) -> AnalyzeResponse:
    start = time.perf_counter()
    key = _cache_key(req.text)

    if key in _cache:
        cached = _cache[key].model_copy(update={"cache_hit": True})
        logger.info("CACHE HIT  url=%s", req.source_url)
        return cached

    try:
        is_phishing, risk, intents, explain = _mock_analyze(req.text)
    except Exception as e:
        logger.exception("analyze failed")
        raise HTTPException(status_code=500, detail=str(e))

    latency = int((time.perf_counter() - start) * 1000)
    resp = AnalyzeResponse(
        is_phishing=is_phishing,
        risk_level=risk,
        detected_intents=intents,
        explanation=explain,
        latency_ms=latency,
        engine="mock-keyword-v1",
        cache_hit=False,
    )
    _cache[key] = resp
    logger.info(
        "ANALYZE  url=%s risk=%s intents=%s latency=%dms",
        req.source_url, risk, intents, latency,
    )
    return resp


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="127.0.0.1", port=8080, reload=True)
