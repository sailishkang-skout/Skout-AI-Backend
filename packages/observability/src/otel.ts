import { trace, context, propagation, SpanStatusCode, type Span, type Tracer } from "@opentelemetry/api";
import { BasicTracerProvider, SimpleSpanProcessor, ConsoleSpanExporter, type SpanExporter } from "@opentelemetry/sdk-trace-base";
import { AsyncHooksContextManager } from "@opentelemetry/context-async-hooks";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from "@opentelemetry/semantic-conventions";
import { OtlpHttpSpanExporter, parseOtlpHeaders } from "./otlp-http-exporter.js";

let initialized = false;
let tracerProvider: BasicTracerProvider | null = null;

/**
 * §11.3 Observability — OpenTelemetry tracing baseline. Additive alongside the existing
 * Pino/Sentry/Datadog stack (packages/observability/src/{logger,sentry,datadog}.ts), not a
 * replacement — dd-trace keeps doing Datadog APM; this gives the codebase a real, portable
 * OpenTelemetry trace/span model so a user action can be correlated through async BullMQ workers
 * and cross-service calls regardless of which APM backend a given deployment uses.
 *
 * Wave 1 scope: an in-process tracer provider exporting spans via `ConsoleSpanExporter` — every
 * package this needs (@opentelemetry/api, sdk-trace-base, resources, semantic-conventions,
 * context-async-hooks) is already present in this monorepo's pnpm store as a transitive
 * dependency of dd-trace/Sentry, declared as direct dependencies, no new network fetch needed.
 *
 * §1.1/§11.3 Task 32 (Enterprise Completion Plan "close everything" pass) closes the Wave 2 gap
 * this doc comment used to name: `buildExporter()` now returns a real OTLP/HTTP exporter
 * (./otlp-http-exporter.ts) whenever `OTEL_EXPORTER_OTLP_ENDPOINT` is set, falling back to
 * `ConsoleSpanExporter` when it isn't — so `OTEL_TRACING_ENABLED=true` alone still gives a
 * local/dev-verifiable stdout trace with zero extra config, and setting the endpoint on top of
 * that is what actually ships spans to a real backend (Honeycomb, Grafana Tempo, an OpenTelemetry
 * Collector, Datadog's OTLP intake) — still a product/infra decision to point it anywhere, just
 * no longer a code change to make once that decision is made. See otlp-http-exporter.ts's own
 * doc comment for why this is hand-written against the OTLP/HTTP JSON wire protocol rather than
 * `@opentelemetry/exporter-trace-otlp-http` (unresolvable from this sandbox — no network).
 *
 * Remaining Wave 2 items, unchanged by this pass: propagating trace context through every
 * BullMQ queue (7 of ~15 are wired as of Task 18; see docs/adr/0004's Update section), the 8
 * periodic sweep workers still having no root span of their own (Task 33 — separate commit),
 * apps/ai (Python) instrumentation (Task 38), and the business-journey metrics / anomaly
 * detection the vision doc itself describes as later additions once the baseline exists.
 *
 * Off by default — same on/off pattern as initDatadogTracer(): only activates when
 * OTEL_TRACING_ENABLED is truthy, so this is a no-op in every environment that hasn't opted in.
 */
export function initOpenTelemetry(): boolean {
  if (initialized) return true;
  if (process.env.OTEL_TRACING_ENABLED !== "true") return false;

  try {
    const contextManager = new AsyncHooksContextManager();
    contextManager.enable();
    context.setGlobalContextManager(contextManager);

    const resource = resourceFromAttributes({
      [ATTR_SERVICE_NAME]: process.env.OTEL_SERVICE_NAME ?? process.env.SERVICE_NAME ?? "skout-api",
      [ATTR_SERVICE_VERSION]: process.env.SERVICE_VERSION ?? "unknown",
    });

    tracerProvider = new BasicTracerProvider({
      resource,
      spanProcessors: [new SimpleSpanProcessor(buildExporter())],
    });
    trace.setGlobalTracerProvider(tracerProvider);

    initialized = true;
    return true;
  } catch {
    return false;
  }
}

function buildExporter(): SpanExporter {
  // Standard OTel env var name (https://opentelemetry.io/docs/specs/otel/protocol/exporter/).
  // OTEL_EXPORTER_OTLP_TRACES_ENDPOINT (the traces-specific variant of the same spec) takes
  // precedence if both are set, matching every other OTel SDK's precedence rule.
  const endpoint = process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT || process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  if (endpoint) {
    return new OtlpHttpSpanExporter({
      endpoint,
      headers: parseOtlpHeaders(process.env.OTEL_EXPORTER_OTLP_HEADERS),
      serviceAttributes: {
        "service.name": process.env.OTEL_SERVICE_NAME ?? process.env.SERVICE_NAME ?? "skout-api",
        "service.version": process.env.SERVICE_VERSION ?? "unknown",
      },
    });
  }
  // No OTLP endpoint configured — Console export keeps OTEL_TRACING_ENABLED=true useful for
  // local/dev verification with zero extra config, exactly as it was before Task 32.
  return new ConsoleSpanExporter();
}

export function getTracer(name = "skout"): Tracer {
  return trace.getTracer(name);
}

/** Runs `fn` inside a new span named `name`, recording thrown errors before rethrowing. */
export async function withSpan<T>(name: string, fn: (span: Span) => Promise<T> | T): Promise<T> {
  const tracer = getTracer();
  return tracer.startActiveSpan(name, async (span) => {
    try {
      const result = await fn(span);
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (err) {
      span.recordException(err as Error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: (err as Error).message });
      throw err;
    } finally {
      span.end();
    }
  });
}

/**
 * W3C trace-context propagation for BullMQ job payloads. `job.data` is plain JSON, so the
 * current trace context is serialized into a small carrier object a queue's job payload type
 * can spread in (e.g. `{ ...payload, traceContext: injectTraceContext() }`), and the consuming
 * worker calls `extractTraceContext(job.data.traceContext)` to resume the same trace.
 */
export function injectTraceContext(): Record<string, string> {
  const carrier: Record<string, string> = {};
  propagation.inject(context.active(), carrier);
  return carrier;
}

export function extractTraceContext(carrier: Record<string, string> | undefined) {
  if (!carrier) return context.active();
  return propagation.extract(context.active(), carrier);
}
