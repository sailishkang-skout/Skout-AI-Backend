import type { SpanKind, SpanStatusCode } from "@opentelemetry/api";
import type { ReadableSpan, SpanExporter } from "@opentelemetry/sdk-trace-base";
import { ExportResultCode, type ExportResult } from "@opentelemetry/core";

/**
 * §1.1 / §11.3 (Enterprise Completion Plan) — real OTLP/HTTP JSON span exporter, closing the
 * Wave 2 gap ADR 0004 named explicitly: "swapping ConsoleSpanExporter for a real OTLP exporter
 * is a one-line change in buildExporter() once the team picks a backend." This sandbox cannot
 * run `pnpm install` (no network), so pulling in `@opentelemetry/exporter-trace-otlp-http` —
 * the obvious off-the-shelf package for this — isn't something that can be verified to resolve
 * from here (same constraint ADR 0004's own "Environment note" already discloses for the rest
 * of this file's dependencies). Rather than add an unverifiable import, this is a small,
 * hand-written exporter against the documented OTLP/HTTP JSON wire protocol
 * (https://opentelemetry.io/docs/specs/otlp/#otlphttp), using Node's built-in `fetch` (Node
 * >=20 everywhere this runs — see root package.json's engines field and each app's Dockerfile) instead of a
 * new dependency. `@opentelemetry/core` (for ExportResult/ExportResultCode) is not new either —
 * it's already a hard dependency of `@opentelemetry/sdk-trace-base`, just not previously
 * declared directly; it is now (see this package's package.json).
 *
 * Deliberately scoped to what a real OTLP/HTTP JSON backend (Honeycomb, Grafana Tempo, the
 * OpenTelemetry Collector, Datadog's OTLP intake) needs to accept trace data, not a full
 * reimplementation of the exporter SDK:
 *   - Span Links are not sent — nothing in this codebase's current withSpan()/getTracer() usage
 *     creates any, so there's nothing to serialize yet; add link support here if that changes.
 *   - Every numeric attribute value is sent as OTLP's `doubleValue` rather than distinguishing
 *     `intValue` (which protobuf-JSON encodes as a string to dodge int64 precision loss in JS).
 *     `doubleValue` only loses precision past 2^53 — no attribute value anywhere in this
 *     codebase's spans approaches that, so this is a real, disclosed simplification, not a
 *     silent one.
 * If either gap starts to matter, this is the file to extend — not a reason to keep shipping
 * Console-only export until the OTLP spec is implemented end-to-end.
 */

interface OtlpHttpExporterOptions {
  /** Base collector endpoint, e.g. "https://otel-collector.example.com". `/v1/traces` is
   * appended — pass an endpoint that already includes a full nonstandard path if a backend
   * needs one. */
  endpoint: string;
  headers?: Record<string, string>;
  /** Resource attributes attached to every span in this process's export (service.name,
   * service.version, ...). */
  serviceAttributes: Record<string, string>;
}

/** OTLP JSON encodes trace_id/span_id `bytes` fields as base64 (standard protobuf JSON mapping),
 * not the hex strings @opentelemetry/api's SpanContext carries them as internally. */
function hexToBase64(hex: string): string {
  return Buffer.from(hex, "hex").toString("base64");
}

/** HrTime is a [seconds, nanoseconds] tuple. Unix-nano-since-epoch overflows a safe JS integer
 * (~1.7e18 today), so this uses BigInt to avoid silently corrupting every span's timestamp. */
function hrTimeToUnixNanoString(hrTime: readonly [number, number]): string {
  const [seconds, nanos] = hrTime;
  return (BigInt(Math.trunc(seconds)) * 1_000_000_000n + BigInt(Math.trunc(nanos))).toString();
}

function attributeValueToOtlp(value: unknown): Record<string, unknown> {
  if (typeof value === "string") return { stringValue: value };
  if (typeof value === "boolean") return { boolValue: value };
  if (typeof value === "number") return { doubleValue: value };
  if (Array.isArray(value)) {
    return { arrayValue: { values: value.map((v) => attributeValueToOtlp(v)) } };
  }
  return { stringValue: String(value) };
}

function attributesToOtlp(attributes: Record<string, unknown> | undefined): Array<{ key: string; value: unknown }> {
  if (!attributes) return [];
  return Object.entries(attributes)
    .filter(([, v]) => v !== undefined)
    .map(([key, value]) => ({ key, value: attributeValueToOtlp(value) }));
}

/** OTel API SpanKind (INTERNAL=0 .. CONSUMER=4) -> OTLP proto SpanKind (UNSPECIFIED=0,
 * INTERNAL=1 .. CONSUMER=5). The two enums are offset by exactly one. */
function spanKindToOtlp(kind: SpanKind): number {
  return (kind as unknown as number) + 1;
}

/** OTel API SpanStatusCode (UNSET=0, OK=1, ERROR=2) numbers identically to OTLP's StatusCode. */
function statusCodeToOtlp(code: SpanStatusCode): number {
  return code as unknown as number;
}

function spanToOtlp(span: ReadableSpan) {
  const ctx = span.spanContext();
  return {
    traceId: hexToBase64(ctx.traceId),
    spanId: hexToBase64(ctx.spanId),
    ...(span.parentSpanId ? { parentSpanId: hexToBase64(span.parentSpanId) } : {}),
    name: span.name,
    kind: spanKindToOtlp(span.kind),
    startTimeUnixNano: hrTimeToUnixNanoString(span.startTime),
    endTimeUnixNano: hrTimeToUnixNanoString(span.endTime),
    attributes: attributesToOtlp(span.attributes as Record<string, unknown>),
    droppedAttributesCount: span.droppedAttributesCount ?? 0,
    events: (span.events ?? []).map((event) => ({
      timeUnixNano: hrTimeToUnixNanoString(event.time),
      name: event.name,
      attributes: attributesToOtlp(event.attributes as Record<string, unknown> | undefined),
    })),
    droppedEventsCount: span.droppedEventsCount ?? 0,
    droppedLinksCount: span.droppedLinksCount ?? 0,
    status: {
      code: statusCodeToOtlp(span.status.code),
      ...(span.status.message ? { message: span.status.message } : {}),
    },
  };
}

/**
 * Groups spans into OTLP's ExportTraceServiceRequest shape (resourceSpans[].scopeSpans[].spans).
 * In practice every span this process emits shares one resource (this service) and one scope
 * ("skout" — see getTracer() in otel.ts), so this always produces exactly one resourceSpans
 * entry with one scopeSpans entry — the grouping is kept general (by scope name+version) rather
 * than hardcoded to "always one group" so it stays correct if that ever changes.
 */
function buildExportRequest(spans: ReadableSpan[], serviceAttributes: Record<string, string>) {
  const groups = new Map<string, { scopeName: string; scopeVersion?: string; spans: ReadableSpan[] }>();
  for (const span of spans) {
    const scope = (span as unknown as { instrumentationScope?: { name: string; version?: string } })
      .instrumentationScope ?? { name: "skout" };
    const key = `${scope.name}@${scope.version ?? ""}`;
    const group = groups.get(key);
    if (group) group.spans.push(span);
    else groups.set(key, { scopeName: scope.name, scopeVersion: scope.version, spans: [span] });
  }

  return {
    resourceSpans: [
      {
        resource: {
          attributes: Object.entries(serviceAttributes).map(([key, value]) => ({
            key,
            value: { stringValue: value },
          })),
        },
        scopeSpans: [...groups.values()].map((group) => ({
          scope: { name: group.scopeName, ...(group.scopeVersion ? { version: group.scopeVersion } : {}) },
          spans: group.spans.map(spanToOtlp),
        })),
      },
    ],
  };
}

/**
 * Minimal OTLP/HTTP JSON SpanExporter. Posts to `${endpoint}/v1/traces`. Export failures are
 * logged to stderr and reported via the SpanExporter contract's ExportResultCode.FAILED — they
 * never throw into the tracing pipeline itself, since a telemetry backend being briefly
 * unreachable must never be able to break (or even slow down, beyond the fetch's own timeout)
 * the request actually being traced.
 */
export class OtlpHttpSpanExporter implements SpanExporter {
  private readonly endpoint: string;
  private readonly headers: Record<string, string>;
  private readonly serviceAttributes: Record<string, string>;
  private shutdownFlag = false;

  constructor(options: OtlpHttpExporterOptions) {
    this.endpoint = options.endpoint.replace(/\/+$/, "");
    this.headers = options.headers ?? {};
    this.serviceAttributes = options.serviceAttributes;
  }

  export(spans: ReadableSpan[], resultCallback: (result: ExportResult) => void): void {
    if (this.shutdownFlag || spans.length === 0) {
      resultCallback({ code: ExportResultCode.SUCCESS });
      return;
    }

    const body = JSON.stringify(buildExportRequest(spans, this.serviceAttributes));

    fetch(`${this.endpoint}/v1/traces`, {
      method: "POST",
      headers: { "content-type": "application/json", ...this.headers },
      body,
    })
      .then((res) => {
        if (!res.ok) {
          console.error(`[otel] OTLP export failed: HTTP ${res.status} ${res.statusText}`);
          resultCallback({ code: ExportResultCode.FAILED });
          return;
        }
        resultCallback({ code: ExportResultCode.SUCCESS });
      })
      .catch((err: unknown) => {
        console.error("[otel] OTLP export failed", err);
        resultCallback({ code: ExportResultCode.FAILED, error: err as Error });
      });
  }

  async shutdown(): Promise<void> {
    this.shutdownFlag = true;
  }

  async forceFlush(): Promise<void> {
    // Nothing buffered internally beyond whatever export() calls have in-flight fetches.
  }
}

/**
 * Parses the standard `OTEL_EXPORTER_OTLP_HEADERS` env format: comma-separated `key=value`
 * pairs (https://opentelemetry.io/docs/specs/otel/protocol/exporter/), e.g.
 * "x-honeycomb-team=abc123,x-honeycomb-dataset=skout-api". Malformed entries are skipped, not
 * thrown — a typo in this env var shouldn't crash startup.
 */
export function parseOtlpHeaders(raw: string | undefined): Record<string, string> {
  if (!raw) return {};
  const headers: Record<string, string> = {};
  for (const pair of raw.split(",")) {
    const eq = pair.indexOf("=");
    if (eq <= 0) continue;
    const key = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    if (key && value) headers[key] = decodeURIComponent(value);
  }
  return headers;
}
