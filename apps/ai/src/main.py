"""Skout AI — Python AI orchestration service (FastAPI + LangGraph + LiteLLM)."""

import atexit
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
        analytics_capture(**kwargs)
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


class ClassifyRequest(BaseModel):
    thread_id: str
    content: str


class ClassifyResponse(BaseModel):
    intent: str
    confidence: float
    requires_hitl: bool


@app.get("/health")
def health():
    return {"status": "ok", "service": "skout-ai"}


@app.post("/v1/classify", response_model=ClassifyResponse)
def classify(request: ClassifyRequest):
    """Intent classification stub — wire LiteLLM router + HITL escalation."""
    result = ClassifyResponse(
        intent="interested",
        confidence=0.72,
        requires_hitl=True,
    )
    analytics_capture(
        distinct_id=request.thread_id,
        event="prospect_classified",
        properties={
            "intent": result.intent,
            "confidence": result.confidence,
            "requires_hitl": result.requires_hitl,
        },
    )
    return result


# ---------------------------------------------------------------------------
# ICP / lead scoring (strategy §9, ticket E6.1)
# ---------------------------------------------------------------------------


class ProspectInput(BaseModel):
    prospect_id: str
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
    min_employees: Optional[int] = None
    max_employees: Optional[int] = None


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


_INTENT_SIGNALS = {
    "recent_funding": "Scaling Sales Team",
    "recent_hiring": "Lead Generation Issues",
    "leadership_change": "Revenue Operations Complexity",
    "market_expansion": "Scaling Sales Team",
    "product_launch": "Lead Generation Issues",
}


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


@app.post("/v1/score", response_model=ScoreResponse)
def score(request: ScoreRequest):
    """Heuristic ICP + intent scoring.

    Deterministic baseline so the pipeline works without an LLM; swap the body
    for a LiteLLM call when model scoring is wired (keeps the same contract).
    """
    p = request.prospect
    icp = request.icp
    score = 40
    reasons: list[str] = []

    if icp.industries and p.industry:
        if p.industry in icp.industries:
            score += 20
            reasons.append("industry match")
        else:
            score -= 10
    if icp.seniorities and p.seniority:
        if p.seniority in icp.seniorities:
            score += 15
            reasons.append("seniority match")
    if icp.countries and p.country:
        if p.country in icp.countries:
            score += 10
            reasons.append("geo match")
        else:
            score -= 5
    if p.employee_count is not None:
        lo = icp.min_employees if icp.min_employees is not None else 0
        hi = icp.max_employees if icp.max_employees is not None else 10**9
        if lo <= p.employee_count <= hi:
            score += 10
            reasons.append("size fit")

    icp_score = max(0, min(100, score))

    intent_score = min(100, len(p.signals) * 25)
    pain_points = sorted({_INTENT_SIGNALS[s] for s in p.signals if s in _INTENT_SIGNALS})

    result = ScoreResponse(
        prospect_id=p.prospect_id,
        icp_score=icp_score,
        icp_band=_band(icp_score),
        intent_score=intent_score,
        pain_points=pain_points,
        outreach_readiness=_readiness(icp_score, intent_score),
        reasoning=", ".join(reasons) or "baseline score (no ICP signals matched)",
    )
    analytics_capture(
        distinct_id=p.prospect_id,
        event="prospect_scored",
        properties={
            "icp_score": result.icp_score,
            "icp_band": result.icp_band,
            "intent_score": result.intent_score,
            "outreach_readiness": result.outreach_readiness,
            "num_pain_points": len(result.pain_points),
            "num_signals": len(p.signals),
        },
    )
    return result


# ---------------------------------------------------------------------------
# LLM pain points + personalization (strategy §9)
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


def _llm_available() -> bool:
    import os
    return bool(os.getenv("OPENAI_API_KEY"))


def _llm_json(prompt: str) -> dict:
    import os
    from litellm import completion

    model = os.getenv("AI_MODEL", "gpt-4o-mini")
    res = completion(
        model=model,
        messages=[{"role": "user", "content": prompt}],
        response_format={"type": "json_object"},
    )
    import json
    content = res.choices[0].message.content or "{}"
    return json.loads(content)


@app.post("/v1/pain-points", response_model=PainPointResponse)
def pain_points(request: PainPointRequest):
    """Detect pain points via LLM when OPENAI_API_KEY is set, else heuristic."""
    if _llm_available():
        prompt = (
            "Analyze this B2B prospect and return JSON with key pain_points (array of strings). "
            f"Title: {request.title}, Industry: {request.industry}, Domain: {request.company_domain}, "
            f"Description: {request.description}, Signals: {request.signals}, Jobs: {request.job_post_snippets}"
        )
        data = _llm_json(prompt)
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
        data = _llm_json(prompt)
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
