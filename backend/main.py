"""
Intent-Based Phishing Detector — FastAPI 中繼站
組員 A：前端與系統整合

Week 14：Mock keyword 分類器，凍結 JSON schema 供前端串接。
Week 15：接上真實 LLM — 本地 Ollama (fine-tuned) + 雲端 OpenAI (baseline) 雙引擎熱插拔。
        mock 保留為離線 fallback 與 smoke test 用途。
"""
from __future__ import annotations

import hashlib
import logging
import time
from typing import Literal

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

import llm_engine

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
)
logger = logging.getLogger("phishing-detector")

app = FastAPI(
    title="Intent-Based Phishing Detector API",
    description="LLM 意圖分析中繼站 — 接收網頁文本，回傳釣魚風險評估",
    version="0.2.0-week15",
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
Engine = Literal["ollama", "openai", "gemini", "nvidia", "mock"]


class AnalyzeRequest(BaseModel):
    text: str = Field(..., min_length=1, max_length=20000, description="網頁擷取的純文本")
    source_url: str | None = Field(None, description="文本來源 URL，用於除錯與快取 key")
    lang: str | None = Field("zh-TW", description="文本主要語言")
    engine: Engine | None = Field(None, description="指定引擎，未填則用後端預設")


class AnalyzeResponse(BaseModel):
    is_phishing: bool
    risk_level: RiskLevel
    detected_intents: list[ThreatIntent]
    explanation: str = Field(..., description="繁體中文白話解釋，<= 50 字")
    latency_ms: int
    engine: str = Field(..., description="實際呼叫的 LLM 引擎名稱，方便 Week 15 對照實驗")
    cache_hit: bool = False


# ---------- 快取：以 (engine, text) 為 key，避免不同引擎結果互相污染 ----------

_cache: dict[str, AnalyzeResponse] = {}


def _cache_key(text: str, engine: str) -> str:
    return hashlib.sha256(f"{engine}::{text}".encode("utf-8")).hexdigest()


# ---------- Mock 分類器：離線 fallback / smoke test ----------

_INTENT_KEYWORDS: dict[ThreatIntent, list[str]] = {
    "Urgency":   ["立即", "限時", "24小時內", "兩小時內", "逾期", "盡快", "馬上", "停權", "凍結"],
    "Authority": ["客服", "官方", "銀行", "蝦皮", "健保署", "國稅局", "警政署", "LINE Pay", "郵局"],
    "Financial": ["匯款", "點數", "轉帳", "薪資", "退稅", "扣款", "信用卡", "驗證身分"],
    "Greed":     ["中獎", "免費", "領取", "禮品", "優惠", "紅包"],
}


def _mock_analyze(text: str) -> dict:
    hits: list[ThreatIntent] = []
    for intent, keywords in _INTENT_KEYWORDS.items():
        if any(kw in text for kw in keywords):
            hits.append(intent)
    if len(hits) >= 2:
        return {"is_phishing": True, "risk_level": "High", "detected_intents": hits,
                "explanation": f"偵測到{len(hits)}種社交工程意圖（{', '.join(hits)}），高度疑似釣魚訊息。"}
    if len(hits) == 1:
        return {"is_phishing": True, "risk_level": "Medium", "detected_intents": hits,
                "explanation": f"出現「{hits[0]}」類型語句，請謹慎判斷。"}
    return {"is_phishing": False, "risk_level": "Low", "detected_intents": ["None"],
            "explanation": "未偵測到明顯的社交工程意圖。"}


# ---------- API ----------

@app.get("/health")
def health() -> dict[str, str]:
    return {
        "status": "ok",
        "version": app.version,
        "default_engine": llm_engine.DEFAULT_ENGINE,
    }


@app.post("/analyze", response_model=AnalyzeResponse)
async def analyze(req: AnalyzeRequest) -> AnalyzeResponse:
    start = time.perf_counter()
    engine = (req.engine or llm_engine.DEFAULT_ENGINE).lower()
    key = _cache_key(req.text, engine)

    if key in _cache:
        logger.info("CACHE HIT  engine=%s url=%s", engine, req.source_url)
        hit_latency = int((time.perf_counter() - start) * 1000)
        return _cache[key].model_copy(update={"cache_hit": True, "latency_ms": hit_latency})

    try:
        if engine == "mock":
            result = _mock_analyze(req.text)
            engine_label = "mock-keyword-v1"
        else:
            result, engine_label = await llm_engine.analyze_with_engine(req.text, engine)
    except Exception as e:
        logger.exception("analyze failed (engine=%s)", engine)
        # 降級：LLM 掛掉時退回 mock，確保前端永遠有結果（附註引擎來源）
        result = _mock_analyze(req.text)
        engine_label = f"mock-fallback (原因: {type(e).__name__})"

    latency = int((time.perf_counter() - start) * 1000)
    resp = AnalyzeResponse(
        **result,
        latency_ms=latency,
        engine=engine_label,
        cache_hit=False,
    )
    # mock-fallback 結果不寫快取，下次仍會嘗試真實引擎
    if not engine_label.startswith("mock-fallback"):
        _cache[key] = resp
    logger.info(
        "ANALYZE  engine=%s risk=%s intents=%s latency=%dms url=%s",
        engine_label, resp.risk_level, resp.detected_intents, latency, req.source_url,
    )
    return resp


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="127.0.0.1", port=8080, reload=True)
