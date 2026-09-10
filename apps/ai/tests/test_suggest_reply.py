"""Tests for POST /v1/suggest-reply — inbox reply drafting (heuristic path)."""
from unittest.mock import patch

from fastapi.testclient import TestClient

from src.main import app

client = TestClient(app)

BASE = {
    "thread_id": "thr-1",
    "prospect_id": "p-1",
    "prospect_name": "Ada Lovelace",
    "prospect_title": "VP Engineering",
    "company_name": "Analytical Engines",
    "company_domain": "ae.example",
    "icp_score": 82,
    "subject": "Quick intro",
    "messages": [
        {"direction": "outbound", "body": "Hi Ada — noticed you are hiring.", "from_address": "me@skout.ai"},
        {"direction": "inbound", "body": "Interesting — can we talk Thursday?", "from_address": "ada@ae.example"},
    ],
}


def test_suggest_reply_heuristic_meeting_tag():
    with patch("src.main._llm_available", return_value=False):
        res = client.post("/v1/suggest-reply", json={**BASE, "reply_tag": "meeting_request"})
    assert res.status_code == 200
    data = res.json()
    assert data["source"] == "heuristic"
    assert data["thread_id"] == "thr-1"
    assert "times" in data["body"].lower() or "connect" in data["body"].lower()
    assert 0 <= data["confidence"] <= 1


def test_suggest_reply_heuristic_generic():
    with patch("src.main._llm_available", return_value=False):
        res = client.post("/v1/suggest-reply", json=BASE)
    assert res.status_code == 200
    data = res.json()
    assert data["body"]
    assert data["subject"].lower().startswith("re:")


def test_suggest_reply_empty_messages():
    with patch("src.main._llm_available", return_value=False):
        res = client.post(
            "/v1/suggest-reply",
            json={"thread_id": "thr-empty", "messages": []},
        )
    assert res.status_code == 200
    assert res.json()["confidence"] <= 0.4
