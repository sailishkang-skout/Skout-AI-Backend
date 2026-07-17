"""Tests for /v1/classify intent classification (R5.2) — heuristic path, no LLM required."""

import os
import sys
from pathlib import Path

# Ensure apps/ai/src is importable
sys.path.insert(0, str(Path(__file__).resolve().parent))

# Force heuristic path (no OpenRouter during unit tests)
os.environ.pop("OPENROUTER_API_KEY", None)

from main import (  # noqa: E402
    ClassifyRequest,
    classify,
    classify_intent,
    _classify_message_heuristic,
    _intent_score_from_signals,
)


def test_message_unsubscribe():
    label, conf, _ = _classify_message_heuristic("Please unsubscribe me from this list")
    assert label == "unsubscribe"
    assert conf >= 0.9


def test_message_meeting():
    label, conf, _ = _classify_message_heuristic("Can we book a call next week?")
    assert label == "meeting"
    assert conf >= 0.85


def test_message_buy():
    label, _, _ = _classify_message_heuristic("Send over pricing — ready to purchase")
    assert label == "buy"


def test_message_interested():
    label, _, _ = _classify_message_heuristic("Sounds interesting, tell me more")
    assert label == "interested"


def test_signals_intent_score_strong():
    score = _intent_score_from_signals(["recent_funding", "recent_hiring"])
    assert score >= 80
    assert score <= 100


def test_classify_intent_from_signals():
    result = classify_intent(signals=["recent_funding", "product_launch"], title="VP Sales")
    assert result.intent in {"buy", "need", "interested", "respond"}
    assert result.intent_score > 0
    assert result.source == "heuristic"
    assert 0 <= result.confidence <= 1


def test_classify_intent_from_content():
    result = classify_intent(content="Let's schedule a demo on your calendar")
    assert result.intent == "meeting"
    assert result.intent_score >= 80
    assert result.requires_hitl is False  # high confidence meeting


def test_classify_low_confidence_hitl():
    result = classify_intent(content="hello")
    assert result.intent in {"other", "respond"}
    assert result.requires_hitl is True


def test_classify_endpoint_empty_not_hardcoded_interested():
    result = classify(ClassifyRequest(thread_id="t1", content=""))
    assert result.intent == "other"
    assert result.requires_hitl is True
    assert result.intent_score == 0


def test_classify_endpoint_content():
    result = classify(
        ClassifyRequest(thread_id="t2", content="We are evaluating vendors and need a solution")
    )
    assert result.intent == "need"
    assert result.rationale
    assert "intent" in result.model_dump()


def test_classify_endpoint_prospect_signals():
    result = classify(
        ClassifyRequest(
            prospect_id="p1",
            signals=["recent_hiring"],
            job_post_snippets=["Hiring SDRs in NYC"],
            title="CRO",
            industry="SaaS",
        )
    )
    assert result.intent_score > 0
    assert result.source == "heuristic"
    assert result.outreach_readiness in {"ready", "warm", "nurture", "not_qualified"}
