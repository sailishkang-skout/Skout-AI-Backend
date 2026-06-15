"""Skout AI — Python AI orchestration service (FastAPI + LangGraph + LiteLLM)."""

from typing import Optional

from fastapi import FastAPI
from pydantic import BaseModel

app = FastAPI(title="Skout AI Service", version="0.1.0")


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
    return ClassifyResponse(
        intent="interested",
        confidence=0.72,
        requires_hitl=True,
    )


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

    return ScoreResponse(
        prospect_id=p.prospect_id,
        icp_score=icp_score,
        icp_band=_band(icp_score),
        intent_score=intent_score,
        pain_points=pain_points,
        outreach_readiness=_readiness(icp_score, intent_score),
        reasoning=", ".join(reasons) or "baseline score (no ICP signals matched)",
    )


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
        return PainPointResponse(
            prospect_id=request.prospect_id,
            pain_points=data.get("pain_points", []),
            source="llm",
        )
    pts = sorted({_INTENT_SIGNALS[s] for s in request.signals if s in _INTENT_SIGNALS})
    if request.job_post_snippets:
        pts.append("Recruitment Challenges")
    return PainPointResponse(prospect_id=request.prospect_id, pain_points=pts, source="heuristic")


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
        return PersonalizeResponse(
            prospect_id=request.prospect_id,
            opener=data.get("opener", ""),
            talking_points=data.get("talking_points", []),
            source="llm",
        )
    name = request.full_name or "there"
    domain = request.company_domain or "your company"
    return PersonalizeResponse(
        prospect_id=request.prospect_id,
        opener=f"Hi {name} — noticed {domain} is scaling. Thought this might resonate.",
        talking_points=request.pain_points[:3] or ["Growth", "Efficiency"],
        source="heuristic",
    )
