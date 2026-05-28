"""
LLM 引擎抽象層 — 雙引擎熱插拔
組員 A：前端與系統整合（Week 15）

設計目標：
  - 同一個 prompt template、同一個輸出 JSON schema
  - 雲端 baseline (OpenAI) 與本地 fine-tuned (Ollama) 共用，確保對照實驗公平
  - 解析 LLM 自由輸出 → 強制收斂為 AnalyzeResponse 結構

引擎選擇優先序：
  1. /analyze 請求帶 engine 參數（前端 Options 頁切換）
  2. 環境變數 DEFAULT_ENGINE
  3. fallback: mock
"""
from __future__ import annotations

import json
import os
import re

import httpx

# ---------------- 設定（環境變數可覆寫） ----------------

OLLAMA_HOST = os.getenv("OLLAMA_HOST", "http://127.0.0.1:11434")
OLLAMA_MODEL = os.getenv("OLLAMA_MODEL", "phishing-detector")

OPENAI_BASE = os.getenv("OPENAI_BASE", "https://api.openai.com/v1")
OPENAI_API_KEY = os.getenv("OPENAI_API_KEY", "")
OPENAI_MODEL = os.getenv("OPENAI_MODEL", "gpt-4o-mini")

GEMINI_BASE = os.getenv("GEMINI_BASE", "https://generativelanguage.googleapis.com/v1beta")
GEMINI_API_KEY = os.getenv("GEMINI_API_KEY", "")
# Gemini 2.0 Flash 於 2026-03-03 退役。2026 年免費層可用（按推薦序）：
#   - gemini-3.5-flash       ← 實測可用，本 PoC 採用
#   - gemini-2.5-flash       (10 RPM, 250 RPD)
#   - gemini-2.5-flash-lite  (15 RPM, 1000 RPD)
GEMINI_MODEL = os.getenv("GEMINI_MODEL", "gemini-3.5-flash")

NVIDIA_BASE = os.getenv("NVIDIA_BASE", "https://integrate.api.nvidia.com/v1")
NVIDIA_API_KEY = os.getenv("NVIDIA_API_KEY", "")
NVIDIA_MODEL = os.getenv("NVIDIA_MODEL", "meta/llama-3.1-8b-instruct")

DEFAULT_ENGINE = os.getenv("DEFAULT_ENGINE", "ollama")

# ---------------- Prompt（與 INPUT_SPEC.md §2.1 / Modelfile 一致） ----------------

SYSTEM_PROMPT = """你是一個進階的 SOC 資安意圖分析引擎。請分析使用者輸入的網頁／信件文本，找出潛藏的社交工程攻擊意圖。

【判斷邏輯】
不要只依賴網址特徵。請深層分析文本是否包含「製造急迫感」、「冒充權威」、「誘騙提供財務或登入資訊」、「貪婪誘惑」等社交工程意圖。

【意圖標籤定義】
- Urgency：製造時間壓力（如「24 小時內」「立即」「凍結」「逾期」）
- Authority：冒充權威或品牌（銀行、政府機關、知名電商、客服）
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
不可附加 markdown 程式碼框、不可有額外說明文字。"""


def build_user_message(text: str) -> str:
    """L2 User Message 模板（與 INPUT_SPEC.md §2.2 一致）"""
    return f"<text>\n{text}\n</text>"


# ---------------- 輸出解析：把 LLM 自由文字收斂為合法 JSON ----------------

_VALID_INTENTS = {"Urgency", "Authority", "Financial", "Greed", "None"}
_VALID_RISK = {"High", "Medium", "Low"}


def _extract_json(raw: str) -> dict:
    """
    LLM 可能輸出 ```json ... ```、夾帶說明文字等。
    策略：先剝 code fence，再抓第一個 {...} 區塊。
    """
    s = raw.strip()
    s = re.sub(r"^```(?:json)?\s*", "", s)
    s = re.sub(r"\s*```$", "", s)
    try:
        return json.loads(s)
    except json.JSONDecodeError:
        pass
    # 退而求其次：找第一個平衡的大括號區塊
    m = re.search(r"\{.*\}", s, re.DOTALL)
    if m:
        return json.loads(m.group(0))
    raise ValueError(f"無法從 LLM 輸出解析 JSON: {raw[:200]!r}")


def normalize_result(data: dict) -> dict:
    """強制收斂欄位，防止 LLM 亂填導致前端崩潰。"""
    risk = data.get("risk_level", "Low")
    if risk not in _VALID_RISK:
        risk = "Low"

    intents = data.get("detected_intents", [])
    if not isinstance(intents, list):
        intents = []
    intents = [i for i in intents if i in _VALID_INTENTS] or ["None"]

    is_phishing = bool(data.get("is_phishing", False))
    explanation = str(data.get("explanation", "")).strip()[:80] or "（模型未提供解釋）"

    return {
        "is_phishing": is_phishing,
        "risk_level": risk,
        "detected_intents": intents,
        "explanation": explanation,
    }


# ---------------- 引擎實作 ----------------

async def call_ollama(text: str) -> dict:
    """呼叫本地 Ollama（fine-tuned 模型）。"""
    url = f"{OLLAMA_HOST}/api/chat"
    payload = {
        "model": OLLAMA_MODEL,
        "messages": [
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": build_user_message(text)},
        ],
        "stream": False,
        "format": "json",   # Ollama 原生 JSON mode，大幅提升輸出穩定度
        "options": {"temperature": 0.1},
    }
    async with httpx.AsyncClient(timeout=60.0) as client:
        r = await client.post(url, json=payload)
        r.raise_for_status()
        raw = r.json()["message"]["content"]
    return normalize_result(_extract_json(raw))


async def call_openai(text: str) -> dict:
    """呼叫 OpenAI（雲端 baseline 對照組）。"""
    if not OPENAI_API_KEY:
        raise RuntimeError("未設定 OPENAI_API_KEY 環境變數")
    url = f"{OPENAI_BASE}/chat/completions"
    payload = {
        "model": OPENAI_MODEL,
        "messages": [
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": build_user_message(text)},
        ],
        "temperature": 0.1,
        "response_format": {"type": "json_object"},
    }
    headers = {"Authorization": f"Bearer {OPENAI_API_KEY}"}
    async with httpx.AsyncClient(timeout=60.0) as client:
        r = await client.post(url, json=payload, headers=headers)
        r.raise_for_status()
        raw = r.json()["choices"][0]["message"]["content"]
    return normalize_result(_extract_json(raw))


async def call_gemini(text: str) -> dict:
    """呼叫 Google Gemini（雲端 baseline，免費額度大、Gemini Flash 反應快）。"""
    if not GEMINI_API_KEY:
        raise RuntimeError("未設定 GEMINI_API_KEY 環境變數")
    url = f"{GEMINI_BASE}/models/{GEMINI_MODEL}:generateContent"
    payload = {
        "systemInstruction": {"parts": [{"text": SYSTEM_PROMPT}]},
        "contents": [
            {"role": "user", "parts": [{"text": build_user_message(text)}]}
        ],
        "generationConfig": {
            "temperature": 0.1,
            "responseMimeType": "application/json",  # Gemini 原生 JSON mode
        },
    }
    headers = {"x-goog-api-key": GEMINI_API_KEY}
    async with httpx.AsyncClient(timeout=60.0) as client:
        r = await client.post(url, json=payload, headers=headers)
        if r.status_code >= 400:
            # 把 Gemini 真實錯誤訊息塞進例外，方便上層日誌顯示
            raise RuntimeError(f"Gemini API {r.status_code}: {r.text[:500]}")
        data = r.json()
        try:
            raw = data["candidates"][0]["content"]["parts"][0]["text"]
        except (KeyError, IndexError) as e:
            raise RuntimeError(f"Gemini 回傳結構異常: {data}") from e
    return normalize_result(_extract_json(raw))


async def call_nvidia(text: str) -> dict:
    """呼叫 NVIDIA NIM（雲端 baseline，提供 Llama / Qwen 等 OSS 模型）。
    NIM 介面與 OpenAI 相容，僅 endpoint 與 model 名稱不同。"""
    if not NVIDIA_API_KEY:
        raise RuntimeError("未設定 NVIDIA_API_KEY 環境變數")
    url = f"{NVIDIA_BASE}/chat/completions"
    payload = {
        "model": NVIDIA_MODEL,
        "messages": [
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": build_user_message(text)},
        ],
        "temperature": 0.1,
        # NVIDIA NIM 部分模型支援 JSON mode，不支援就退回正則抓 JSON
        "response_format": {"type": "json_object"},
    }
    headers = {"Authorization": f"Bearer {NVIDIA_API_KEY}"}
    async with httpx.AsyncClient(timeout=60.0) as client:
        r = await client.post(url, json=payload, headers=headers)
        r.raise_for_status()
        raw = r.json()["choices"][0]["message"]["content"]
    return normalize_result(_extract_json(raw))


# ---------------- 引擎路由 ----------------

ENGINE_LABELS = {
    "ollama": OLLAMA_MODEL,
    "openai": OPENAI_MODEL,
    "gemini": GEMINI_MODEL,
    "nvidia": NVIDIA_MODEL,
}


async def analyze_with_engine(text: str, engine: str | None = None) -> tuple[dict, str]:
    """
    回傳 (normalized_result, engine_label)
    呼叫端負責補上 latency_ms / cache_hit。
    """
    engine = (engine or DEFAULT_ENGINE).lower()
    if engine == "ollama":
        return await call_ollama(text), f"ollama:{OLLAMA_MODEL}"
    if engine == "openai":
        return await call_openai(text), f"openai:{OPENAI_MODEL}"
    if engine == "gemini":
        return await call_gemini(text), f"gemini:{GEMINI_MODEL}"
    if engine == "nvidia":
        return await call_nvidia(text), f"nvidia:{NVIDIA_MODEL}"
    raise ValueError(f"未知的引擎: {engine}")
