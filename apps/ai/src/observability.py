"""
§1.1 / §11.3 Task 38 (Enterprise Completion Plan) - OpenTelemetry-compatible tracing for
apps/ai, closing the last named gap in packages/observability/src/otel.ts's own doc comment
("apps/ai (Python) instrumentation (Task 38)").

This sandbox cannot `pip install` (no network - the same constraint documented in
packages/observability/src/otlp-http-exporter.ts for the Node side), so this is not built on
the real `opentelemetry-sdk` / `opentelemetry-exporter-otlp-proto-http` packages - neither is
installed here, and adding them to requirements.txt couldn't be verified to actually resolve or
match the API this file assumes. Instead this is a small, dependency-free, stdlib-only tracer
that speaks the same two wire formats the Node side (packages/observability/src/{otel,
otlp-http-exporter}.ts) already speaks, so the two services compose into one distributed trace
without sharing a library across two different languages:

  - W3C Trace Context (the `traceparent` header, https://www.w3.org/TR/trace-context/) for
    picking up the trace apps/api already started (via its own injectTraceContext(), added to
    the three real apps/api -> apps/ai call sites in this same Task 38 commit) and continuing it
    here as a child span, instead of every AI call starting a disconnected root span.
  - OTLP/HTTP JSON (https://opentelemetry.io/docs/specs/otlp/#otlphttp) for exporting finished
    spans, using the SAME env var names as the Node side (OTEL_TRACING_ENABLED,
    OTEL_EXPORTER_OTLP_TRACES_ENDPOINT / OTEL_EXPORTER_OTLP_ENDPOINT,
    OTEL_EXPORTER_OTLP_HEADERS, OTEL_SERVICE_NAME) so one collector config covers both services,
    and the same "no endpoint configured -> print to stdout" fallback so OTEL_TRACING_ENABLED=
    true alone is still useful for local/dev verification with zero extra config.

Off by default (OTEL_TRACING_ENABLED must be exactly "true", checked fresh on every export - not
cached at import time, so tests and reconfiguration don't need a process restart). Every public
function here is wrapped so it can never raise into the caller's request path - tracing must
never be the reason a real AI request fails, the same principle this file's neighbours in
main.py (posthog's analytics_capture, sentry_sdk.init) already follow.

Scope note: this wires one span per HTTP request (see main.py's _TracingMiddleware) using a
contextvar to track "the current span's trace/parent," so a nested start_span() call made from
the same async task parents correctly onto the request span. It does NOT attempt nested child
spans across FastAPI's sync-endpoint threadpool boundary (most routes in this file are plain
`def`, not `async def`, so their body runs via Starlette's run_in_threadpool) - that boundary
does propagate contextvars in current Starlette versions, but verifying that precisely is out of
scope for this pass and not needed for the primary goal (a correctly trace-linked span per
request). start_span() is a real, general-purpose primitive if a future pass wants to add finer-
grained spans inside a route body.
"""

from __future__ import annotations

import contextvars
import json
import os
import secrets
import threading
import time
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from typing import Any, Optional


def _is_enabled() -> bool:
    return os.getenv("OTEL_TRACING_ENABLED", "").strip().lower() == "true"


def _service_name() -> str:
    return os.getenv("OTEL_SERVICE_NAME") or os.getenv("SERVICE_NAME") or "skout-ai"


def _service_version() -> str:
    return os.getenv("SERVICE_VERSION", "unknown")


@dataclass
class _Span:
    name: str
    trace_id: str
    span_id: str
    parent_span_id: Optional[str]
    start_ns: int
    end_ns: Optional[int] = None
    attributes: dict = field(default_factory=dict)
    status_code: str = "UNSET"  # UNSET | OK | ERROR
    status_message: str = ""


# Holds (trace_id, span_id) of the span currently "active" in this async task, so a nested
# start_span() call parents onto it instead of starting an unrelated new trace.
_current_trace: "contextvars.ContextVar[Optional[tuple]]" = contextvars.ContextVar(
    "_current_trace", default=None
)


def _new_id(nbytes: int) -> str:
    return secrets.token_hex(nbytes)


def parse_traceparent(header: Optional[str]) -> Optional[tuple]:
    """Parses a W3C `traceparent` header into (trace_id, parent_span_id). Returns None for a
    missing or malformed header rather than raising - an untrusted inbound header must never
    break the request it's attached to."""
    if not header:
        return None
    try:
        parts = header.strip().split("-")
        if len(parts) != 4:
            return None
        version, trace_id, parent_id, _flags = parts
        if version != "00" or len(trace_id) != 32 or len(parent_id) != 16:
            return None
        int(trace_id, 16)
        int(parent_id, 16)
        if trace_id == "0" * 32 or parent_id == "0" * 16:
            return None
        return trace_id, parent_id
    except Exception:
        return None


def _parse_otlp_headers(raw: Optional[str]) -> dict:
    """`key1=value1,key2=value2` - same format as the Node side's parseOtlpHeaders()
    (packages/observability/src/otlp-http-exporter.ts)."""
    headers: dict = {}
    if not raw:
        return headers
    for pair in raw.split(","):
        if "=" not in pair:
            continue
        k, v = pair.split("=", 1)
        k, v = k.strip(), v.strip()
        if k:
            headers[k] = v
    return headers


def _attrs_to_otlp(attributes: dict) -> list:
    out = []
    for k, v in attributes.items():
        if v is None:
            continue
        if isinstance(v, bool):
            value = {"boolValue": v}
        elif isinstance(v, (int, float)):
            # Matches the Node exporter's simplification: everything numeric goes out as
            # doubleValue rather than distinguishing intValue - see that file's doc comment for
            # why (no attribute value in this codebase's spans approaches 2^53).
            value = {"doubleValue": float(v)}
        else:
            value = {"stringValue": str(v)}
        out.append({"key": k, "value": value})
    return out


class _SpanExporter:
    """Best-effort exports finished spans as OTLP/HTTP JSON, mirroring
    packages/observability/src/otlp-http-exporter.ts's wire shape so both services' spans land
    in the same collector/backend in the same format. No batching/queueing - each request's
    single span is exported synchronously right after it ends, which is fine at this service's
    traffic pattern (a handful of AI calls per user action, not a high-frequency hot loop)."""

    def add(self, span: _Span) -> None:
        if not _is_enabled():
            return
        try:
            endpoint = os.getenv("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT") or os.getenv("OTEL_EXPORTER_OTLP_ENDPOINT")
            if not endpoint:
                # No collector configured - stdout export keeps OTEL_TRACING_ENABLED=true useful
                # for local/dev verification with zero extra config, same fallback the Node
                # side's ConsoleSpanExporter provides.
                dur_ms = ((span.end_ns or span.start_ns) - span.start_ns) / 1e6
                print(
                    f"[otel] {span.name} trace={span.trace_id} span={span.span_id} "
                    f"parent={span.parent_span_id} dur_ms={dur_ms:.2f} status={span.status_code} "
                    f"attrs={json.dumps(span.attributes, default=str)}"
                )
                return
            self._export([span], endpoint)
        except Exception:
            # Tracing must never fail (or be the slow part of) a real AI request.
            pass

    def _export(self, spans: list, endpoint: str) -> None:
        try:
            url = endpoint.rstrip("/")
            if not url.endswith("/v1/traces"):
                url = f"{url}/v1/traces"
            body = json.dumps(self._to_otlp(spans)).encode("utf-8")
            headers = {"Content-Type": "application/json"}
            headers.update(_parse_otlp_headers(os.getenv("OTEL_EXPORTER_OTLP_HEADERS")))
            req = urllib.request.Request(url, data=body, headers=headers, method="POST")
            urllib.request.urlopen(req, timeout=5)
        except Exception:
            pass

    def _to_otlp(self, spans: list) -> dict:
        otlp_spans = []
        for s in spans:
            otlp_spans.append(
                {
                    "traceId": s.trace_id,
                    "spanId": s.span_id,
                    **({"parentSpanId": s.parent_span_id} if s.parent_span_id else {}),
                    "name": s.name,
                    "kind": 1,  # INTERNAL - matches spanKindToOtlp's default on the Node side
                    "startTimeUnixNano": str(s.start_ns),
                    "endTimeUnixNano": str(s.end_ns or s.start_ns),
                    "attributes": _attrs_to_otlp(s.attributes),
                    "droppedAttributesCount": 0,
                    "events": [],
                    "droppedEventsCount": 0,
                    "droppedLinksCount": 0,
                    "status": {"code": {"UNSET": 0, "OK": 1, "ERROR": 2}[s.status_code], "message": s.status_message},
                }
            )
        return {
            "resourceSpans": [
                {
                    "resource": {
                        "attributes": [
                            {"key": "service.name", "value": {"stringValue": _service_name()}},
                            {"key": "service.version", "value": {"stringValue": _service_version()}},
                        ]
                    },
                    "scopeSpans": [{"scope": {"name": "skout-ai"}, "spans": otlp_spans}],
                }
            ]
        }


_exporter = _SpanExporter()
_export_lock = threading.Lock()


class SpanHandle:
    """Returned by start_span(). Use as a context manager, or call set_attribute/set_status/
    record_exception/end() directly."""

    def __init__(self, span: _Span, token: Any) -> None:
        self._span = span
        self._token = token
        self._ended = False

    def set_attribute(self, key: str, value: Any) -> None:
        try:
            self._span.attributes[key] = value
        except Exception:
            pass

    def set_status(self, code: str, message: str = "") -> None:
        try:
            self._span.status_code = code
            self._span.status_message = message
        except Exception:
            pass

    def record_exception(self, exc: BaseException) -> None:
        self.set_attribute("exception.type", type(exc).__name__)
        self.set_attribute("exception.message", str(exc))

    def end(self) -> None:
        if self._ended:
            return
        self._ended = True
        try:
            self._span.end_ns = time.time_ns()
        except Exception:
            pass
        if self._token is not None:
            try:
                _current_trace.reset(self._token)
            except Exception:
                pass
        with _export_lock:
            _exporter.add(self._span)

    def __enter__(self) -> "SpanHandle":
        return self

    def __exit__(self, exc_type, exc, tb) -> None:
        if exc is not None:
            self.record_exception(exc)
            self.set_status("ERROR", str(exc))
        elif self._span.status_code == "UNSET":
            self.set_status("OK")
        self.end()


def start_span(name: str, *, traceparent: Optional[str] = None, attributes: Optional[dict] = None) -> SpanHandle:
    """Starts a span. Parents onto the current in-process span if one is active in this async
    task's contextvar chain; otherwise continues the trace named by `traceparent` (a W3C header
    value) if it parses; otherwise starts a brand-new trace. Every branch degrades to "start a
    fresh trace" on any unexpected error rather than raising - tracing must never break the
    request it's attached to."""
    try:
        current = _current_trace.get()
        if current is not None:
            trace_id, parent_span_id = current
        else:
            parsed = parse_traceparent(traceparent)
            if parsed is not None:
                trace_id, parent_span_id = parsed
            else:
                trace_id, parent_span_id = _new_id(16), None

        span = _Span(
            name=name,
            trace_id=trace_id,
            span_id=_new_id(8),
            parent_span_id=parent_span_id,
            start_ns=time.time_ns(),
            attributes=dict(attributes or {}),
        )
        token = _current_trace.set((span.trace_id, span.span_id))
        return SpanHandle(span, token)
    except Exception:
        dummy = _Span(name=name, trace_id="0" * 32, span_id="0" * 16, parent_span_id=None, start_ns=0)
        handle = SpanHandle(dummy, None)
        handle._ended = True  # end() becomes a no-op; nothing gets exported for this fallback span
        return handle
