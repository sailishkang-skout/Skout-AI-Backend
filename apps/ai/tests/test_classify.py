"""
Tests for POST /v1/classify — intent classification endpoint.

Run with:
    cd apps/ai
    pip install pytest httpx
    pytest tests/test_classify.py -v
"""
import json
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient

from src.main import app

client = TestClient(app)

VALID_PAYLOAD = {
    "prospect_id": "test-001",
    "signals": [
        {"type": "recent_funding", "source": "crunchbase", "value": "Series B"},
        {"type": "market_expansion", "source": "press", "value": "EU launch"},
    ],
    "firmographics": {
        "industry": "SaaS",
        "employee_count": 150,
        "country": "US",
        "company_domain": "acme.com",
        "title": "VP of Sales",
        "seniority": "vp",
    },
    "job_posts": [
        {"title": "Head of Revenue Operations", "department": "Sales"}
    ],
}


# ---------------------------------------------------------------------------
# Schema validation
# ---------------------------------------------------------------------------

class TestSchemaValidation:
    def test_missing_prospect_id_returns_422(self):
        payload = {k: v for k, v in VALID_PAYLOAD.items() if k != "prospect_id"}
        res = client.post("/v1/classify", json=payload)
        assert res.status_code == 422

    def test_empty_signals_and_job_posts_is_valid(self):
        res = client.post("/v1/classify", json={
            "prospect_id": "test-minimal",
            "signals": [],
            "job_posts": [],
        })
        assert res.status_code == 200

    def test_firmographics_all_optional(self):
        res = client.post("/v1/classify", json={
            "prospect_id": "test-no-firmographics",
        })
        assert res.status_code == 200

    def test_response_contains_all_required_fields(self):
        res = client.post("/v1/classify", json=VALID_PAYLOAD)
        body = res.json()
        for field in ("prospect_id", "intent", "intent_score", "confidence",
                      "rationale", "signals_used", "outreach_readiness",
                      "requires_hitl", "source"):
            assert field in body, f"missing field: {field}"

    def test_prospect_id_echoed_in_response(self):
        res = client.post("/v1/classify", json=VALID_PAYLOAD)
        assert res.json()["prospect_id"] == "test-001"


# ---------------------------------------------------------------------------
# Heuristic path — intent classification
# ---------------------------------------------------------------------------

class TestHeuristicClassification:
    def test_two_strong_signals_returns_in_market(self):
        res = client.post("/v1/classify", json=VALID_PAYLOAD)
        body = res.json()
        assert body["intent"] == "in_market"
        assert body["intent_score"] == 90

    def test_strong_signal_plus_sales_hiring_returns_in_market(self):
        res = client.post("/v1/classify", json={
            "prospect_id": "t",
            "signals": [{"type": "recent_funding"}],
            "job_posts": [{"title": "Sales Manager"}],
        })
        assert res.json()["intent"] == "in_market"

    def test_single_strong_signal_returns_researching(self):
        res = client.post("/v1/classify", json={
            "prospect_id": "t",
            "signals": [{"type": "recent_funding"}],
            "job_posts": [],
        })
        assert res.json()["intent"] == "researching"

    def test_two_research_signals_returns_researching(self):
        res = client.post("/v1/classify", json={
            "prospect_id": "t",
            "signals": [
                {"type": "recent_hiring"},
                {"type": "leadership_change"},
            ],
        })
        assert res.json()["intent"] == "researching"

    def test_one_research_signal_returns_researching(self):
        res = client.post("/v1/classify", json={
            "prospect_id": "t",
            "signals": [{"type": "recent_hiring"}],
        })
        assert res.json()["intent"] == "researching"

    def test_no_signals_returns_unknown(self):
        res = client.post("/v1/classify", json={
            "prospect_id": "t",
            "signals": [],
            "job_posts": [],
        })
        body = res.json()
        assert body["intent"] == "unknown"
        assert body["intent_score"] == 0

    def test_unknown_signal_type_treated_as_generic(self):
        res = client.post("/v1/classify", json={
            "prospect_id": "t",
            "signals": [{"type": "something_new"}],
        })
        body = res.json()
        assert body["intent"] == "researching"

    def test_intent_score_values_match_map(self):
        expected = {"in_market": 90, "researching": 60, "not_ready": 20, "unknown": 0}
        for intent, score in expected.items():
            if intent == "not_ready":
                continue  # heuristic can't produce not_ready; LLM path only
            res = client.post("/v1/classify", json={
                "prospect_id": "t",
                "signals": [{"type": "recent_funding"}, {"type": "market_expansion"}]
                if intent == "in_market"
                else ([] if intent == "unknown" else [{"type": "recent_hiring"}]),
            })
            assert res.json()["intent_score"] == score, f"wrong score for {intent}"


# ---------------------------------------------------------------------------
# HITL gating
# ---------------------------------------------------------------------------

class TestHitlGating:
    def test_high_confidence_clears_hitl(self):
        # Two strong signals → confidence 0.76 ≥ 0.65 threshold
        res = client.post("/v1/classify", json=VALID_PAYLOAD)
        body = res.json()
        assert body["confidence"] >= 0.65
        assert body["requires_hitl"] is False

    def test_no_signals_sets_hitl(self):
        res = client.post("/v1/classify", json={
            "prospect_id": "t",
            "signals": [],
            "job_posts": [],
        })
        body = res.json()
        assert body["confidence"] < 0.65
        assert body["requires_hitl"] is True

    def test_single_research_signal_sets_hitl(self):
        res = client.post("/v1/classify", json={
            "prospect_id": "t",
            "signals": [{"type": "recent_hiring"}],
        })
        body = res.json()
        assert body["confidence"] == 0.45
        assert body["requires_hitl"] is True

    def test_two_research_signals_sets_hitl(self):
        res = client.post("/v1/classify", json={
            "prospect_id": "t",
            "signals": [{"type": "recent_hiring"}, {"type": "leadership_change"}],
        })
        body = res.json()
        assert body["confidence"] == 0.55
        assert body["requires_hitl"] is True

    def test_hitl_threshold_env_override(self, monkeypatch):
        monkeypatch.setenv("HITL_CONFIDENCE_THRESHOLD", "0.90")
        # Re-import to pick up new threshold
        import importlib
        import src.main as m
        importlib.reload(m)
        new_client = TestClient(m.app)
        res = new_client.post("/v1/classify", json=VALID_PAYLOAD)
        # confidence 0.76 is now below 0.90 threshold
        assert res.json()["requires_hitl"] is True


# ---------------------------------------------------------------------------
# Outreach readiness
# ---------------------------------------------------------------------------

class TestOutreachReadiness:
    def test_in_market_maps_to_ready_or_warm(self):
        res = client.post("/v1/classify", json=VALID_PAYLOAD)
        assert res.json()["outreach_readiness"] in ("ready", "warm")

    def test_researching_maps_to_warm(self):
        res = client.post("/v1/classify", json={
            "prospect_id": "t",
            "signals": [{"type": "recent_hiring"}, {"type": "leadership_change"}],
        })
        assert res.json()["outreach_readiness"] == "warm"

    def test_unknown_maps_to_nurture(self):
        res = client.post("/v1/classify", json={
            "prospect_id": "t",
            "signals": [],
        })
        assert res.json()["outreach_readiness"] == "nurture"

    def test_source_is_heuristic_without_llm_key(self):
        res = client.post("/v1/classify", json=VALID_PAYLOAD)
        assert res.json()["source"] == "heuristic"

    def test_signals_used_contains_detected_types(self):
        res = client.post("/v1/classify", json=VALID_PAYLOAD)
        used = res.json()["signals_used"]
        assert "recent_funding" in used or "market_expansion" in used


# ---------------------------------------------------------------------------
# LLM path — mocked
# ---------------------------------------------------------------------------

class TestLlmPath:
    LLM_RESPONSE = {
        "intent": "in_market",
        "confidence": 0.88,
        "rationale": "Series B funding and EU expansion are strong buy signals.",
        "signals_used": ["recent_funding", "market_expansion"],
    }

    def _patch_llm(self, response=None):
        return patch(
            "src.main._llm_json",
            return_value=response or self.LLM_RESPONSE,
        )

    def _patch_available(self):
        return patch("src.main._llm_available", return_value=True)

    def test_llm_path_returns_source_llm(self):
        with self._patch_available(), self._patch_llm():
            res = client.post("/v1/classify", json=VALID_PAYLOAD)
        assert res.json()["source"] == "llm"

    def test_llm_response_overrides_heuristic_intent(self):
        with self._patch_available(), self._patch_llm({"intent": "not_ready", "confidence": 0.80,
                                                        "rationale": "No active buying motion.", "signals_used": []}):
            res = client.post("/v1/classify", json=VALID_PAYLOAD)
        body = res.json()
        assert body["intent"] == "not_ready"
        assert body["intent_score"] == 20

    def test_llm_invalid_intent_falls_back_to_unknown(self):
        with self._patch_available(), self._patch_llm({"intent": "definitely_buying",
                                                        "confidence": 0.9, "rationale": "sure", "signals_used": []}):
            res = client.post("/v1/classify", json=VALID_PAYLOAD)
        assert res.json()["intent"] == "unknown"

    def test_llm_confidence_clamped_to_1(self):
        with self._patch_available(), self._patch_llm({"intent": "in_market",
                                                        "confidence": 99.0, "rationale": "x", "signals_used": []}):
            res = client.post("/v1/classify", json=VALID_PAYLOAD)
        assert res.json()["confidence"] <= 1.0

    def test_llm_confidence_clamped_to_0(self):
        with self._patch_available(), self._patch_llm({"intent": "unknown",
                                                        "confidence": -5.0, "rationale": "x", "signals_used": []}):
            res = client.post("/v1/classify", json=VALID_PAYLOAD)
        assert res.json()["confidence"] >= 0.0

    def test_llm_non_list_signals_used_falls_back_to_heuristic_list(self):
        with self._patch_available(), self._patch_llm({"intent": "in_market", "confidence": 0.80,
                                                        "rationale": "x", "signals_used": "not a list"}):
            res = client.post("/v1/classify", json=VALID_PAYLOAD)
        assert isinstance(res.json()["signals_used"], list)

    def test_llm_failure_falls_back_to_heuristic(self):
        with self._patch_available(), patch("src.main._llm_json", side_effect=RuntimeError("API down")):
            res = client.post("/v1/classify", json=VALID_PAYLOAD)
        body = res.json()
        assert res.status_code == 200
        assert body["source"] == "heuristic"

    def test_llm_requires_hitl_derived_from_llm_confidence(self):
        with self._patch_available(), self._patch_llm({"intent": "researching",
                                                        "confidence": 0.50, "rationale": "x", "signals_used": []}):
            res = client.post("/v1/classify", json=VALID_PAYLOAD)
        body = res.json()
        assert body["confidence"] == 0.50
        assert body["requires_hitl"] is True
