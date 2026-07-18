"""Skout AI — Python AI orchestration service (FastAPI + LangGraph + LiteLLM)."""

import atexit
import json
import os
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any, Optional, Protocol

import sentry_sdk
from dotenv import load_dotenv
from fastapi import FastAPI
from posthog import Posthog
from pydantic import BaseModel
from sentry_sdk.integrations.fastapi import FastApiIntegration

# Load apps/ai/.env first, then repo root .env for OPENAI_API_KEY etc.
_ai_dir = Path(__file__).resolve().parent.parent
load_dotenv(_ai_dir / ".env")
load_dotenv(_ai_dir.parent.parent / ".env")

_PLACEHOLDER_KEYS = frozenset(
    {"", "replace-me", "replace-me-python", "undefined", "null", "none"}
)


def _is_configured(value: str | None) -> bool:
    if not value or not value.strip():
        return False
    v = value.strip().lower()
    if v in _PLACEHOLDER_KEYS or v.startswith("your_") or "..." in v:
        return False
    return True


class _AnalyticsClient(Protocol):
    def capture(self, *args: Any, **kwargs: Any) -> None: ...
    def shutdown(self) -> None: ...


class _NoOpAnalytics:
    def capture(self, *args: Any, **kwargs: Any) -> None:
        pass

    def shutdown(self) -> None:
        pass


_sentry_dsn = os.getenv("SENTRY_DSN", "").strip()
if _is_configured(_sentry_dsn):
    try:
        sentry_sdk.init(
            dsn=_sentry_dsn,
            integrations=[FastApiIntegration()],
            environment=os.getenv("NODE_ENV", os.getenv("ENVIRONMENT", "development")),
            traces_sample_rate=float(os.getenv("SENTRY_TRACES_SAMPLE_RATE", "0.1")),
            send_default_pii=False,
        )
    except Exception:
        pass

_posthog_key = os.getenv("POSTHOG_PROJECT_TOKEN", os.getenv("POSTHOG_API_KEY", "")).strip()
_posthog_host = os.getenv("POSTHOG_HOST", "https://us.i.posthog.com")


def _create_posthog() -> _AnalyticsClient:
    if not _is_configured(_posthog_key):
        return _NoOpAnalytics()
    try:
        return Posthog(
            api_key=_posthog_key,
            host=_posthog_host,
            enable_exception_autocapture=True,
        )
    except Exception:
        return _NoOpAnalytics()


posthog_client: _AnalyticsClient = _create_posthog()
if not isinstance(posthog_client, _NoOpAnalytics):
    atexit.register(posthog_client.shutdown)


def analytics_capture(**kwargs: Any) -> None:
    try:
        posthog_client.capture(**kwargs)
    except Exception:
        pass


@asynccontextmanager
async def lifespan(app: FastAPI):
    yield
    try:
        posthog_client.shutdown()
    except Exception:
        pass


app = FastAPI(title="Skout AI Service", version="0.1.0", lifespan=lifespan)


# ---------------------------------------------------------------------------
# LLM helpers
# ---------------------------------------------------------------------------


def _llm_available() -> bool:
    return bool(os.getenv("OPENROUTER_API_KEY"))


def _default_model() -> str:
    if os.getenv("AI_MODEL"):
        return os.getenv("AI_MODEL")
    return "openrouter/openai/gpt-4o-mini"


def _llm_json(system_prompt: str, user_prompt: str) -> dict:
    """
    Call the LLM and return parsed JSON.

    The system_prompt is the stable, cacheable part (ICP config + instructions).
    OpenAI automatically caches prompts ≥1024 tokens that share the same prefix,
    so keeping the ICP config in the system message amortises cost across all
    prospects scored against the same ICP in a short window.
    """
    from litellm import completion

    model = _default_model()
    timeout = float(os.getenv("LLM_TIMEOUT_SECS", "4.0"))

    messages = []
    if system_prompt:
        messages.append({"role": "system", "content": system_prompt})
    messages.append({"role": "user", "content": user_prompt})

    extra_kwargs: dict = {
        "api_key": os.getenv("OPENROUTER_API_KEY"),
        "api_base": "https://openrouter.ai/api/v1",
    }

    res = completion(
        model=model,
        messages=messages,
        response_format={"type": "json_object"},
        timeout=timeout,
        **extra_kwargs,
    )
    content = res.choices[0].message.content or "{}"
    return json.loads(content)


# ---------------------------------------------------------------------------
# ICP / lead scoring
# ---------------------------------------------------------------------------


class ProspectInput(BaseModel):
    prospect_id: str
    full_name: Optional[str] = None
    title: Optional[str] = None
    seniority: Optional[str] = None
    industry: Optional[str] = None
    country: Optional[str] = None
    employee_count: Optional[int] = None
    company_domain: Optional[str] = None
    signals: list[str] = []


class IcpConfig(BaseModel):
    industries: list[str] = []
    countries: list[str] = []
    seniorities: list[str] = []
    titles: list[str] = []
    keywords: list[str] = []
    min_employees: Optional[int] = None
    max_employees: Optional[int] = None


class DimensionScore(BaseModel):
    score: int  # 0–100 fit quality for this dimension
    matched: bool
    explanation: str


class ScoreRequest(BaseModel):
    prospect: ProspectInput
    icp: IcpConfig = IcpConfig()


class ScoreResponse(BaseModel):
    prospect_id: str
    icp_score: int  # 0–100
    icp_band: str  # strong | medium | weak
    intent_score: int
    pain_points: list[str]
    outreach_readiness: str  # ready | warm | nurture | not_qualified
    reasoning: str
    source: str  # llm | heuristic
    dimensions: dict[str, DimensionScore]


class ClassifyRequest(BaseModel):
    """Message thread and/or prospect buying-intent context."""

    thread_id: Optional[str] = None
    content: Optional[str] = None
    prospect_id: Optional[str] = None
    title: Optional[str] = None
    industry: Optional[str] = None
    company_domain: Optional[str] = None
    seniority: Optional[str] = None
    employee_count: Optional[int] = None
    signals: list[str] = []
    job_post_snippets: list[str] = []


class ClassifyResponse(BaseModel):
    intent: str  # buy | respond | need | interested | not_interested | meeting | unsubscribe | other
    confidence: float
    requires_hitl: bool
    rationale: str = ""
    intent_score: int = 0  # 0–100 — feeds scoring / outreach readiness
    source: str = "heuristic"  # llm | heuristic
    outreach_readiness: str = "not_qualified"


_INTENT_SIGNALS = {
    "recent_funding": "Scaling Sales Team",
    "recent_hiring": "Lead Generation Issues",
    "leadership_change": "Revenue Operations Complexity",
    "market_expansion": "Scaling Sales Team",
    "product_launch": "Lead Generation Issues",
}

# Typed intents for /v1/classify (R5.2) — buy/respond/need plus reply-oriented labels.
INTENT_LABELS = frozenset(
    {
        "buy",
        "respond",
        "need",
        "interested",
        "not_interested",
        "meeting",
        "unsubscribe",
        "other",
    }
)

# Map typed intent → 0–100 intent_score (feeds outreach readiness).
_INTENT_SCORE_BY_LABEL: dict[str, int] = {
    "buy": 90,
    "meeting": 85,
    "need": 72,
    "interested": 65,
    "respond": 55,
    "other": 35,
    "not_interested": 10,
    "unsubscribe": 5,
}

_HITL_CONFIDENCE_THRESHOLD = float(os.getenv("HITL_CONFIDENCE_THRESHOLD", "0.65"))


def _intent_score_from_signals(signals: list[str], job_post_snippets: list[str] | None = None) -> int:
    """Deterministic buying-intent score from corpus signals + hiring evidence."""
    base = min(100, len(signals) * 25)
    if job_post_snippets:
        base = min(100, base + min(20, len(job_post_snippets) * 5))
    # Stronger weights for high-intent signal types
    strong = {"recent_funding", "recent_hiring", "product_launch", "market_expansion"}
    if any(s in strong for s in signals):
        base = min(100, max(base, 50 + 15 * sum(1 for s in signals if s in strong)))
    return max(0, min(100, base))


def _label_from_intent_score(score: int) -> str:
    if score >= 80:
        return "buy"
    if score >= 65:
        return "need"
    if score >= 45:
        return "respond"
    if score >= 25:
        return "interested"
    return "other"


def _classify_message_heuristic(content: str) -> tuple[str, float, str]:
    """Keyword heuristic for reply / message thread text."""
    text = (content or "").strip().lower()
    if not text:
        return "other", 0.35, "Empty message — no intent signals"

    checks: list[tuple[str, tuple[str, ...], float, str]] = [
        (
            "unsubscribe",
            ("unsubscribe", "remove me", "stop emailing", "opt out", "do not contact", "don't contact"),
            0.92,
            "Opt-out / unsubscribe language",
        ),
        (
            "not_interested",
            ("not interested", "no thanks", "no thank you", "pass for now", "please remove"),
            0.88,
            "Clear rejection language",
        ),
        (
            "meeting",
            ("book a call", "schedule a", "calendar", "meet next", "demo next", "available for a call", "let's meet"),
            0.9,
            "Meeting / calendar request",
        ),
        (
            "buy",
            ("pricing", "purchase", "buy", "procurement", "contract", "invoice", "ready to purchase"),
            0.85,
            "Purchase / pricing language",
        ),
        (
            "need",
            ("looking for", "we need", "evaluating", "rfp", "vendor", "solution for", "pain point"),
            0.8,
            "Active need / evaluation language",
        ),
        (
            "interested",
            ("interested", "tell me more", "sounds good", "learn more", "send more info", "curious about"),
            0.78,
            "Positive interest language",
        ),
        (
            "respond",
            ("thanks for reaching", "got your note", "following up", "circling back", "who is this"),
            0.7,
            "Acknowledgement / reply without clear buying signal",
        ),
    ]

    for label, needles, conf, rationale in checks:
        if any(n in text for n in needles):
            return label, conf, rationale

    # Short generic replies
    if len(text.split()) <= 6:
        return "respond", 0.45, "Short reply without strong intent keywords"
    return "other", 0.4, "No strong intent keywords matched"


def _classify_prospect_heuristic(
    signals: list[str],
    job_post_snippets: list[str],
    title: str | None,
    industry: str | None,
) -> tuple[str, float, str, int]:
    score = _intent_score_from_signals(signals, job_post_snippets)
    label = _label_from_intent_score(score)
    parts: list[str] = []
    if signals:
        parts.append(f"signals={','.join(signals)}")
    if job_post_snippets:
        parts.append(f"{len(job_post_snippets)} job-post snippet(s)")
    if title:
        parts.append(f"title={title}")
    if industry:
        parts.append(f"industry={industry}")
    rationale = "; ".join(parts) or "No firmographic or signal evidence"
    # Confidence rises with evidence volume
    evidence = len(signals) + (1 if job_post_snippets else 0) + (1 if title else 0)
    confidence = min(0.95, 0.4 + 0.12 * evidence)
    if not signals and not job_post_snippets:
        confidence = 0.35
        label = "other"
    return label, confidence, rationale, score


def _normalize_intent_label(raw: str) -> str:
    label = (raw or "other").strip().lower().replace("-", "_").replace(" ", "_")
    aliases = {
        "buying": "buy",
        "purchase": "buy",
        "response": "respond",
        "reply": "respond",
        "needs": "need",
        "interest": "interested",
        "positive": "interested",
        "negative": "not_interested",
        "meeting_request": "meeting",
        "demo": "meeting",
        "opt_out": "unsubscribe",
    }
    label = aliases.get(label, label)
    return label if label in INTENT_LABELS else "other"


def _classify_intent_signal_based(
    *,
    content: str | None = None,
    signals: list[str] | None = None,
    job_post_snippets: list[str] | None = None,
    title: str | None = None,
    industry: str | None = None,
    company_domain: str | None = None,
    seniority: str | None = None,
    employee_count: int | None = None,
) -> ClassifyResponse:
    """
    Real intent classifier (R5.2): LLM when OpenRouter is configured, else heuristic.
    Supports message-thread content and/or prospect signals + firmographics + job posts.
    """
    signals = signals or []
    job_post_snippets = job_post_snippets or []
    content = (content or "").strip()

    # Heuristic baseline (always computed — used as fallback and for score merge)
    if content and not signals and not job_post_snippets:
        h_label, h_conf, h_rationale = _classify_message_heuristic(content)
        h_score = _INTENT_SCORE_BY_LABEL.get(h_label, 35)
    else:
        h_label, h_conf, h_rationale, h_score = _classify_prospect_heuristic(
            signals, job_post_snippets, title, industry
        )
        if content:
            m_label, m_conf, m_rationale = _classify_message_heuristic(content)
            # Message evidence can override when stronger
            if m_conf >= h_conf and m_label != "other":
                h_label, h_conf, h_rationale = m_label, m_conf, f"{m_rationale}; {h_rationale}"
                h_score = max(h_score, _INTENT_SCORE_BY_LABEL.get(m_label, h_score))

    source = "heuristic"
    label, confidence, rationale, intent_score = h_label, h_conf, h_rationale, h_score

    if _llm_available():
        try:
            system = (
                "You are a B2B sales intent classifier for Skout AI.\n"
                "Return JSON only with keys:\n"
                '  intent: one of buy|respond|need|interested|not_interested|meeting|unsubscribe|other\n'
                "  confidence: float 0-1\n"
                "  rationale: short string\n"
                "  intent_score: integer 0-100 (buying readiness; higher = more likely to engage/buy)\n"
                "Definitions: buy=purchase-ready, need=active problem, respond=will reply/engage, "
                "interested=curious, meeting=wants a call, not_interested=rejection, "
                "unsubscribe=opt-out, other=unclear."
            )
            user = {
                "content": content or None,
                "signals": signals,
                "job_post_snippets": job_post_snippets[:8],
                "title": title,
                "industry": industry,
                "company_domain": company_domain,
                "seniority": seniority,
                "employee_count": employee_count,
                "heuristic_baseline": {
                    "intent": h_label,
                    "confidence": h_conf,
                    "intent_score": h_score,
                    "rationale": h_rationale,
                },
            }
            data = _llm_json(system, json.dumps(user))
            label = _normalize_intent_label(str(data.get("intent", h_label)))
            confidence = float(data.get("confidence", h_conf))
            confidence = max(0.0, min(1.0, confidence))
            rationale = str(data.get("rationale") or h_rationale)
            intent_score = int(data.get("intent_score", h_score))
            intent_score = max(0, min(100, intent_score))
            # Prefer label-mapped score if LLM omitted a sensible score
            if "intent_score" not in data:
                intent_score = max(intent_score, _INTENT_SCORE_BY_LABEL.get(label, intent_score))
            source = "llm"
        except Exception as e:
            print(f"[classify] LLM failed, using heuristic: {e}")

    requires_hitl = confidence < _HITL_CONFIDENCE_THRESHOLD or label == "other"

    return ClassifyResponse(
        intent=label,
        confidence=round(confidence, 4),
        requires_hitl=requires_hitl,
        rationale=rationale[:1000],
        intent_score=intent_score,
        source=source,
        outreach_readiness=_readiness(70, intent_score) if intent_score else "not_qualified",
    )


def _band(score: int) -> str:
    if score >= 75:
        return "strong"
    if score >= 45:
        return "medium"
    return "weak"


def _readiness(icp: int, intent: int) -> str:
    if icp >= 75 and intent >= 60:
        return "ready"
    if icp >= 60:
        return "warm"
    if icp >= 40:
        return "nurture"
    return "not_qualified"


def _score_heuristic(request: ScoreRequest) -> ScoreResponse:
    """Deterministic ICP + intent baseline when LLM is unavailable."""
    p = request.prospect
    icp = request.icp
    score = 40
    dims: dict[str, dict] = {}

    # Industry
    if icp.industries and p.industry:
        if p.industry in icp.industries:
            score += 20
            dims["industry"] = {"score": 80, "matched": True, "explanation": f"{p.industry} is in target industries"}
        else:
            score -= 10
            dims["industry"] = {"score": 20, "matched": False, "explanation": f"{p.industry} not in target industries"}
    else:
        dims["industry"] = {"score": 50, "matched": True, "explanation": "Industry not specified in ICP"}

    # Seniority
    if icp.seniorities and p.seniority:
        if p.seniority in icp.seniorities:
            score += 15
            dims["seniority"] = {"score": 80, "matched": True, "explanation": f"{p.seniority} matches target seniority"}
        else:
            dims["seniority"] = {"score": 30, "matched": False, "explanation": f"{p.seniority} not in target seniorities"}
    else:
        dims["seniority"] = {"score": 50, "matched": True, "explanation": "Seniority not specified in ICP"}

    # Geography
    if icp.countries and p.country:
        if p.country in icp.countries:
            score += 10
            dims["geography"] = {"score": 80, "matched": True, "explanation": f"{p.country} is in target countries"}
        else:
            score -= 5
            dims["geography"] = {"score": 20, "matched": False, "explanation": f"{p.country} not in target countries"}
    else:
        dims["geography"] = {"score": 50, "matched": True, "explanation": "Geography not specified in ICP"}

    # Company size
    if p.employee_count is not None:
        lo = icp.min_employees if icp.min_employees is not None else 0
        hi = icp.max_employees if icp.max_employees is not None else 10**9
        if lo <= p.employee_count <= hi:
            score += 10
            dims["company_size"] = {"score": 80, "matched": True, "explanation": f"{p.employee_count} employees fits {lo}–{hi} range"}
        else:
            dims["company_size"] = {"score": 20, "matched": False, "explanation": f"{p.employee_count} employees outside {lo}–{hi} range"}
    else:
        dims["company_size"] = {"score": 50, "matched": True, "explanation": "Employee count unknown"}

    # Title / keywords
    if icp.titles and p.title:
        title_l = p.title.lower()
        if any(t.lower() in title_l or title_l in t.lower() for t in icp.titles):
            score += 10
            dims["title"] = {"score": 80, "matched": True, "explanation": f"{p.title} matches target titles"}
        else:
            dims["title"] = {"score": 30, "matched": False, "explanation": f"{p.title} not in target titles"}
    elif icp.keywords and p.title:
        title_l = p.title.lower()
        if any(kw.lower() in title_l for kw in icp.keywords):
            score += 5
            dims["title"] = {"score": 65, "matched": True, "explanation": f"{p.title} matches target keywords"}
        else:
            dims["title"] = {"score": 40, "matched": False, "explanation": "Title does not match keywords"}
    else:
        dims["title"] = {"score": 50, "matched": True, "explanation": "Title not specified in ICP"}

    # Signals / intent — shared with /v1/classify (R5.2)
    intent_score = _intent_score_from_signals(p.signals)
    if p.signals:
        dims["signals"] = {"score": intent_score, "matched": True, "explanation": f"{len(p.signals)} signal(s): {', '.join(p.signals)}"}
    else:
        dims["signals"] = {"score": 0, "matched": False, "explanation": "No intent signals detected"}

    icp_score = max(0, min(100, score))
    pain_points = sorted({_INTENT_SIGNALS[s] for s in p.signals if s in _INTENT_SIGNALS})
    reasons = [
        v["explanation"] for k, v in dims.items()
        if v["matched"] and k != "signals"
        and "not specified" not in v["explanation"]
        and "unknown" not in v["explanation"].lower()
    ]

    return ScoreResponse(
        prospect_id=p.prospect_id,
        icp_score=icp_score,
        icp_band=_band(icp_score),
        intent_score=intent_score,
        pain_points=pain_points,
        outreach_readiness=_readiness(icp_score, intent_score),
        reasoning=", ".join(reasons) or "baseline score (no ICP signals matched)",
        source="heuristic",
        dimensions={k: DimensionScore(**v) for k, v in dims.items()},
    )


def _build_system_prompt(icp: IcpConfig) -> str:
    """
    Build a stable, ICP-keyed system prompt.

    Keeping the ICP in the system message means repeated calls for different
    prospects against the same ICP share a common prefix — OpenAI automatically
    caches prompts ≥1024 tokens that share the same prefix, reducing latency
    and cost on the second+ prospect scored in a short window.
    """
    size_range = (
        f"{icp.min_employees}–{icp.max_employees} employees"
        if icp.min_employees or icp.max_employees
        else "not specified"
    )
    return f"""You are a B2B sales intelligence engine specialised in ICP (Ideal Customer Profile) scoring.

## Your Task
Score a B2B prospect against the ICP configuration below. Return a single JSON object — no markdown, no text outside the JSON.

## ICP Configuration
Industries (target): {icp.industries or 'not specified'}
Seniorities (target): {icp.seniorities or 'not specified'}
Countries / Geographies (target): {icp.countries or 'not specified'}
Job Titles (target): {icp.titles or 'not specified'}
Keywords (must appear in title or role): {icp.keywords or 'not specified'}
Company Size Range: {size_range}

## Scoring Dimensions
Evaluate each dimension independently and assign a 0–100 fit score:

1. industry      — Does the prospect's industry match a target industry?  (weight ~20 pts toward icp_score)
2. seniority     — Does the seniority level match?                        (weight ~15 pts)
3. geography     — Does the country match?                                (weight ~10 pts)
4. company_size  — Does headcount fall within the target range?           (weight ~10 pts)
5. title         — Does the job title match target titles or keywords?    (weight ~15 pts)
6. signals       — Intent signals indicating buying readiness.            (drives intent_score)

## Required JSON Output Schema
{{
  "icp_score": <integer 0–100>,
  "intent_score": <integer 0–100>,
  "pain_points": ["<short string>", ...],
  "reasoning": "<one concise sentence summarising overall fit>",
  "dimensions": {{
    "industry":     {{"score": <0–100>, "matched": <bool>, "explanation": "<why, one sentence>"}},
    "seniority":    {{"score": <0–100>, "matched": <bool>, "explanation": "<why, one sentence>"}},
    "geography":    {{"score": <0–100>, "matched": <bool>, "explanation": "<why, one sentence>"}},
    "company_size": {{"score": <0–100>, "matched": <bool>, "explanation": "<why, one sentence>"}},
    "title":        {{"score": <0–100>, "matched": <bool>, "explanation": "<why, one sentence>"}},
    "signals":      {{"score": <0–100>, "matched": <bool>, "explanation": "<why, one sentence>"}}
  }}
}}

## Scoring Guidelines
- icp_score: weighted composite of all ICP dimensions (not signals)
- intent_score: driven purely by signals — 0 for no signals, up to 100 for multiple strong signals
- pain_points: infer from signals and role; keep to 1–4 short strings
- reasoning: one sentence; name the single biggest driver of the score
- dimension score: fit quality for that dimension (0 = terrible fit, 100 = perfect fit)
- matched: true when the dimension criterion is met OR when the ICP has no constraint for that dimension
- If an ICP field is empty / not specified, treat that dimension as neutral (score: 50, matched: true, explanation: "Not specified in ICP")

## Intent Signal Reference
{json.dumps(_INTENT_SIGNALS)}
"""


def _build_user_prompt(p: ProspectInput, baseline: ScoreResponse) -> str:
    return f"""Score this prospect:
Name: {p.full_name or 'unknown'}
Title: {p.title or 'unknown'}
Seniority: {p.seniority or 'unknown'}
Industry: {p.industry or 'unknown'}
Country: {p.country or 'unknown'}
Employee Count: {p.employee_count or 'unknown'}
Company Domain: {p.company_domain or 'unknown'}
Intent Signals: {p.signals or []}

Heuristic baseline — icp_score={baseline.icp_score}, intent_score={baseline.intent_score}
Refine with judgment; do not copy the baseline blindly."""


def _parse_dimension(raw: Any, fallback: DimensionScore) -> DimensionScore:
    if not isinstance(raw, dict):
        return fallback
    return DimensionScore(
        score=max(0, min(100, int(raw.get("score", fallback.score)))),
        matched=bool(raw.get("matched", fallback.matched)),
        explanation=str(raw.get("explanation", fallback.explanation)),
    )


def _score_llm(request: ScoreRequest, baseline: ScoreResponse) -> ScoreResponse:
    p = request.prospect
    system_prompt = _build_system_prompt(request.icp)
    user_prompt = _build_user_prompt(p, baseline)
    data = _llm_json(system_prompt, user_prompt)

    icp_score = max(0, min(100, int(data.get("icp_score", baseline.icp_score))))
    intent_score = max(0, min(100, int(data.get("intent_score", baseline.intent_score))))

    raw_pain = data.get("pain_points", baseline.pain_points)
    if isinstance(raw_pain, str):
        pain_points = [raw_pain] if raw_pain else []
    elif isinstance(raw_pain, list):
        pain_points = [str(x) for x in raw_pain if x]
    else:
        pain_points = baseline.pain_points

    reasoning = str(data.get("reasoning") or baseline.reasoning)

    raw_dims = data.get("dimensions") or {}
    dimensions = {
        key: _parse_dimension(raw_dims.get(key), fallback)
        for key, fallback in baseline.dimensions.items()
    }
    # Include any extra dimensions the LLM returned that aren't in the baseline
    for key, raw in raw_dims.items():
        if key not in dimensions:
            neutral = DimensionScore(score=50, matched=True, explanation="")
            dimensions[key] = _parse_dimension(raw, neutral)

    return ScoreResponse(
        prospect_id=p.prospect_id,
        icp_score=icp_score,
        icp_band=_band(icp_score),
        intent_score=intent_score,
        pain_points=pain_points,
        outreach_readiness=_readiness(icp_score, intent_score),
        reasoning=reasoning,
        source="llm",
        dimensions=dimensions,
    )


@app.get("/health")
def health():
    return {"status": "ok", "service": "skout-ai"}


@app.post("/v1/score", response_model=ScoreResponse)
def score(request: ScoreRequest):
    """ICP + intent scoring via LLM when configured, else heuristic.

    Intent score is aligned with /v1/classify (R5.2) so buying signals feed
    the same intent_score → outreach_readiness path.
    """
    baseline = _score_heuristic(request)

    # Merge classify-derived intent so score and classify stay consistent (R5.2)
    try:
        classified = _classify_intent_signal_based(
            signals=request.prospect.signals,
            title=request.prospect.title,
            industry=request.prospect.industry,
            company_domain=request.prospect.company_domain,
            seniority=request.prospect.seniority,
            employee_count=request.prospect.employee_count,
        )
        dims = dict(baseline.dimensions)
        prev = dims.get("signals")
        dims["signals"] = DimensionScore(
            score=classified.intent_score,
            matched=classified.intent_score > 0,
            explanation=classified.rationale
            or (prev.explanation if prev else "No intent signals detected"),
        )
        baseline = baseline.model_copy(
            update={
                "intent_score": classified.intent_score,
                "outreach_readiness": _readiness(baseline.icp_score, classified.intent_score),
                "dimensions": dims,
                "reasoning": (
                    f"{baseline.reasoning}; intent={classified.intent} ({classified.source})"
                    if baseline.reasoning
                    else f"intent={classified.intent}"
                ),
            }
        )
    except Exception as e:
        print(f"[score] classify merge skipped: {e}")

    result = baseline
    if _llm_available():
        try:
            result = _score_llm(request, baseline)
        except Exception as e:
            import traceback
            print(f"[score] LLM failed, falling back to heuristic: {e}")
            traceback.print_exc()
            result = baseline

    analytics_capture(
        distinct_id=request.prospect.prospect_id,
        event="prospect_scored",
        properties={
            "icp_score": result.icp_score,
            "icp_band": result.icp_band,
            "intent_score": result.intent_score,
            "outreach_readiness": result.outreach_readiness,
            "num_pain_points": len(result.pain_points),
            "num_signals": len(request.prospect.signals),
            "source": result.source,
        },
    )
    return result


# ---------------------------------------------------------------------------
# Prospect buying-intent classification
# ---------------------------------------------------------------------------

_HITL_CONFIDENCE_THRESHOLD = float(os.getenv("HITL_CONFIDENCE_THRESHOLD", "0.65"))

_INTENT_SCORE_MAP = {
    "in_market": 90,
    "researching": 60,
    "not_ready": 20,
    "unknown": 0,
}

_VALID_INTENTS = frozenset({"in_market", "researching", "not_ready", "unknown"})


class SignalItem(BaseModel):
    type: str
    source: Optional[str] = None
    value: Optional[str] = None


class Firmographics(BaseModel):
    industry: Optional[str] = None
    employee_count: Optional[int] = None
    country: Optional[str] = None
    company_domain: Optional[str] = None
    title: Optional[str] = None
    seniority: Optional[str] = None


class JobPost(BaseModel):
    title: str
    department: Optional[str] = None


class IntentClassifyRequest(BaseModel):
    prospect_id: str
    signals: list[SignalItem] = []
    firmographics: Firmographics = Firmographics()
    job_posts: list[JobPost] = []


class IntentClassifyResponse(BaseModel):
    prospect_id: str
    intent: str              # in_market | researching | not_ready | unknown
    intent_score: int        # 0-100
    confidence: float        # 0.0-1.0
    rationale: str
    signals_used: list[str]
    outreach_readiness: str  # ready | warm | nurture | not_qualified
    requires_hitl: bool
    source: str              # llm | heuristic


def _intent_readiness(intent: str, icp_score: int = 50) -> str:
    if intent == "in_market":
        return "ready" if icp_score >= 60 else "warm"
    if intent == "researching":
        return "warm"
    if intent == "not_ready":
        return "nurture"
    return "nurture"


def _classify_intent_heuristic(request: IntentClassifyRequest) -> IntentClassifyResponse:
    signal_types = [s.type for s in request.signals]
    job_titles = [j.title.lower() for j in request.job_posts]

    strong_buy_signals = {"recent_funding", "market_expansion", "product_launch"}
    research_signals = {"recent_hiring", "leadership_change"}

    strong_count = sum(1 for s in signal_types if s in strong_buy_signals)
    research_count = sum(1 for s in signal_types if s in research_signals)
    has_sales_hiring = any("sales" in t or "revenue" in t or "growth" in t for t in job_titles)

    if strong_count >= 2 or (strong_count >= 1 and has_sales_hiring):
        intent = "in_market"
        confidence = min(0.85, 0.60 + 0.08 * strong_count)
    elif strong_count == 1 or research_count >= 2 or has_sales_hiring:
        intent = "researching"
        confidence = 0.55
    elif research_count == 1:
        intent = "researching"
        confidence = 0.45
    elif signal_types:
        intent = "researching"
        confidence = 0.40
    else:
        intent = "unknown"
        confidence = 0.30

    intent_score = _INTENT_SCORE_MAP.get(intent, 0)
    signals_used = list(set(signal_types[:5]))

    return IntentClassifyResponse(
        prospect_id=request.prospect_id,
        intent=intent,
        intent_score=intent_score,
        confidence=confidence,
        rationale=f"Heuristic: {len(signal_types)} signal(s), {len(request.job_posts)} job post(s).",
        signals_used=signals_used,
        outreach_readiness=_intent_readiness(intent),
        requires_hitl=confidence < _HITL_CONFIDENCE_THRESHOLD,
        source="heuristic",
    )


def _classify_intent_llm(request: IntentClassifyRequest, heuristic: IntentClassifyResponse) -> IntentClassifyResponse:
    f = request.firmographics
    system_prompt = """You are a B2B buying-intent classifier. Given prospect signals, firmographics, and job postings, infer the prospect's purchasing readiness.

Return a single JSON object — no markdown, no text outside JSON.

Required schema:
{
  "intent": "<in_market|researching|not_ready|unknown>",
  "confidence": <float 0.0–1.0>,
  "rationale": "<one concise sentence>",
  "signals_used": ["<signal type>", ...]
}

Intent definitions:
- in_market: actively looking to buy / evaluating solutions now
- researching: aware of the problem, comparing options, not yet ready to commit
- not_ready: no active buying motion detected
- unknown: insufficient data to classify

Confidence: your certainty in the classification (not the probability they'll buy).
signals_used: list the specific signal types that most influenced your decision.
"""
    signal_summary = [{"type": s.type, "source": s.source} for s in request.signals]
    job_summary = [{"title": j.title, "department": j.department} for j in request.job_posts[:5]]
    user_prompt = json.dumps({
        "firmographics": {
            "title": f.title, "seniority": f.seniority, "industry": f.industry,
            "employee_count": f.employee_count, "country": f.country,
        },
        "signals": signal_summary,
        "job_posts": job_summary,
        "heuristic_baseline": heuristic.intent,
    })

    data = _llm_json(system_prompt, user_prompt)
    raw_intent = str(data.get("intent", "unknown"))
    intent = raw_intent if raw_intent in _VALID_INTENTS else "unknown"
    confidence = max(0.0, min(1.0, float(data.get("confidence", heuristic.confidence))))
    rationale = str(data.get("rationale") or heuristic.rationale)
    signals_used = data.get("signals_used", heuristic.signals_used)
    if not isinstance(signals_used, list):
        signals_used = heuristic.signals_used
    signals_used = [str(x) for x in signals_used]

    return IntentClassifyResponse(
        prospect_id=request.prospect_id,
        intent=intent,
        intent_score=_INTENT_SCORE_MAP.get(intent, 0),
        confidence=confidence,
        rationale=rationale,
        signals_used=signals_used,
        outreach_readiness=_intent_readiness(intent),
        requires_hitl=confidence < _HITL_CONFIDENCE_THRESHOLD,
        source="llm",
    )


@app.post("/v1/classify", response_model=IntentClassifyResponse)
def classify_intent(request: IntentClassifyRequest):
    """Prospect buying-intent classification via LLM with heuristic fallback."""
    heuristic = _classify_intent_heuristic(request)
    result = heuristic
    if _llm_available():
        try:
            result = _classify_intent_llm(request, heuristic)
        except Exception as e:
            import traceback
            print(f"[classify] LLM failed, falling back to heuristic: {e}")
            traceback.print_exc()
            result = heuristic

    analytics_capture(
        distinct_id=request.prospect_id,
        event="prospect_intent_classified",
        properties={
            "intent": result.intent,
            "intent_score": result.intent_score,
            "confidence": result.confidence,
            "requires_hitl": result.requires_hitl,
            "source": result.source,
            "num_signals": len(request.signals),
            "num_job_posts": len(request.job_posts),
        },
    )
    return result


# ---------------------------------------------------------------------------
# Prospect buying-intent classification
# ---------------------------------------------------------------------------


class PainPointRequest(BaseModel):
    prospect_id: str
    title: Optional[str] = None
    industry: Optional[str] = None
    company_domain: Optional[str] = None
    description: Optional[str] = None
    signals: list[str] = []
    job_post_snippets: list[str] = []


class PainPointResponse(BaseModel):
    prospect_id: str
    pain_points: list[str]
    source: str  # llm | heuristic


class PersonalizeRequest(BaseModel):
    prospect_id: str
    full_name: Optional[str] = None
    title: Optional[str] = None
    company_domain: Optional[str] = None
    pain_points: list[str] = []
    icp_score: Optional[int] = None


class PersonalizeResponse(BaseModel):
    prospect_id: str
    opener: str
    talking_points: list[str]
    source: str


@app.post("/v1/classify", response_model=ClassifyResponse)
def classify(request: ClassifyRequest):
    """
    Intent classification (R5.2) — LiteLLM when configured, else heuristic.
    Low-confidence / unclear results set requires_hitl=True for human review.
    intent_score feeds ICP outreach readiness when callers merge with /v1/score.
    """
    if not request.content and not request.signals and not request.job_post_snippets:
        # Keep backward-compat for empty observability pings — still not a hardcoded "interested"
        result = ClassifyResponse(
            intent="other",
            confidence=0.3,
            requires_hitl=True,
            rationale="No content or signals provided",
            intent_score=0,
            source="heuristic",
            outreach_readiness="not_qualified",
        )
    else:
        result = _classify_intent_signal_based(
            content=request.content,
            signals=request.signals,
            job_post_snippets=request.job_post_snippets,
            title=request.title,
            industry=request.industry,
            company_domain=request.company_domain,
            seniority=request.seniority,
            employee_count=request.employee_count,
        )

    analytics_capture(
        distinct_id=request.thread_id or request.prospect_id or "anonymous",
        event="prospect_classified",
        properties={
            "intent": result.intent,
            "confidence": result.confidence,
            "requires_hitl": result.requires_hitl,
            "intent_score": result.intent_score,
            "source": result.source,
        },
    )
    return result


@app.post("/v1/pain-points", response_model=PainPointResponse)
def pain_points(request: PainPointRequest):
    """Detect pain points via LLM when OpenRouter is set, else heuristic."""
    if _llm_available():
        prompt = (
            "Analyze this B2B prospect and return JSON with key pain_points (array of strings). "
            f"Title: {request.title}, Industry: {request.industry}, Domain: {request.company_domain}, "
            f"Description: {request.description}, Signals: {request.signals}, Jobs: {request.job_post_snippets}"
        )
        data = _llm_json("", prompt)
        result = PainPointResponse(
            prospect_id=request.prospect_id,
            pain_points=data.get("pain_points", []),
            source="llm",
        )
    else:
        pts = sorted({_INTENT_SIGNALS[s] for s in request.signals if s in _INTENT_SIGNALS})
        if request.job_post_snippets:
            pts.append("Recruitment Challenges")
        result = PainPointResponse(prospect_id=request.prospect_id, pain_points=pts, source="heuristic")

    analytics_capture(
        distinct_id=request.prospect_id,
        event="pain_points_detected",
        properties={
            "num_pain_points": len(result.pain_points),
            "source": result.source,
            "num_signals": len(request.signals),
            "has_job_snippets": bool(request.job_post_snippets),
        },
    )
    return result


@app.post("/v1/personalize", response_model=PersonalizeResponse)
def personalize(request: PersonalizeRequest):
    """Generate outreach opener + talking points for ai_drafts."""
    if _llm_available():
        prompt = (
            "Return JSON with opener (string) and talking_points (array of strings) for a cold email. "
            f"Prospect: {request.full_name}, {request.title} at {request.company_domain}. "
            f"Pain points: {request.pain_points}. ICP score: {request.icp_score}"
        )
        data = _llm_json("", prompt)
        result = PersonalizeResponse(
            prospect_id=request.prospect_id,
            opener=data.get("opener", ""),
            talking_points=data.get("talking_points", []),
            source="llm",
        )
    else:
        name = request.full_name or "there"
        domain = request.company_domain or "your company"
        result = PersonalizeResponse(
            prospect_id=request.prospect_id,
            opener=f"Hi {name} — noticed {domain} is scaling. Thought this might resonate.",
            talking_points=request.pain_points[:3] or ["Growth", "Efficiency"],
            source="heuristic",
        )

    analytics_capture(
        distinct_id=request.prospect_id,
        event="outreach_personalized",
        properties={
            "source": result.source,
            "num_talking_points": len(result.talking_points),
            "has_icp_score": request.icp_score is not None,
            "num_pain_points_input": len(request.pain_points),
        },
    )
    return result
