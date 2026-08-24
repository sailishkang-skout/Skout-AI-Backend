import { trace, context, propagation, SpanStatusCode, type Span, type Tracer } from "@opentelemetry/api";
import { BasicTracerProvider, SimpleSpanProcessor, ConsoleSpanExporter, type SpanExporter } from "@opentelemetry/sdk-trace-base";
import { AsyncHooksContextManager } from "@opentelemetry/context-async-hooks";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from "@opentelemetry/semantic-conventions";

let initialized = false;
let tracerProvider: BasicTracerProvider | null = null;

/**
 * §11.3 Observability — OpenTelemetry tracing baseline. Additive alongside the existing
 * Pino/Sentry/Datadog stack (packages/observability/src/{logger,sentry,datadog}.ts), not a
 * replacement — dd-trace keeps doing Datadog APM; this gives the codebase a real, portable
 * OpenTelemetry trace/span model so a user action can be correlated through async BullMQ workers
 * and cross-service calls regardless of which APM backend a given deployment uses.
 *
 * Wave 1 scope (this pass): an in-process tracer provider exporting spans via
 * `ConsoleSpanExporter` — every package this needs (@opentelemetry/api, sdk-trace-base,
 * resources, semantic-conventions, context-async-hooks) is already present in this monorepo's
 * pnpm store as a transitive dependency of dd-trace/Sentry, so adding them as direct
 * dependencies here needs no new network fetch. Swapping `ConsoleSpanExporter` for a real OTLP
 * exporter (e.g. @opentelemetry/exporter-trace-otlp-http, pointed at Honeycomb/Grafana
 * Tempo/Datadog's OTLP intake) is a one-line change in `buildExporter()` below once the team
 * picks a backend — tracked as Wave 2 in docs/adr/0004-observability-otel-baseline.md, along
 * with propagating trace context through every BullMQ queue (only list-score is wired in this
 * pass, as the worked example) and the business-journey metrics / anomaly detection the vision
 * doc lists as later additions.
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
  // Wave 2: return an OTLP exporter here once one is installed and a backend endpoint is
  // configured (OTEL_EXPORTER_OTLP_ENDPOINT). Console export keeps Wave 1 dependency-free
  // beyond packages already cached in this monorepo's pnpm store.
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
