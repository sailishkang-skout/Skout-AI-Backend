"""Skout AI — Python AI orchestration service (FastAPI + LangGraph + LiteLLM)."""

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
