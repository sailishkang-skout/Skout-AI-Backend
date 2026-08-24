# ADR 0004: OpenTelemetry tracing baseline (§11.3)

## Status
Accepted — Wave 1 of the Enterprise Completion Plan's "next 10" batch.

## Context
§11.3 asks for OpenTelemetry tenant-safe tracing across API/job/model/provider boundaries,
correlating one user action through async BullMQ workers and cross-service calls. Before this
pass, zero OpenTelemetry references existed in the backend — Pino structured logging, Sentry
error capture and an optional Datadog APM hook (`initDatadogTracer`, `dd-trace`) were the only
observability primitives, per the vision doc's own finding.

## Decision
Add a real, in-process OpenTelemetry tracer (`packages/observability/src/otel.ts`) as the
"first deliverable" the doc itself calls for, built entirely on packages already present in this
monorepo's pnpm store as transitive dependencies of `dd-trace`/`@sentry/node`
(`@opentelemetry/api`, `sdk-trace-base`, `resources`, `semantic-conventions`,
`context-async-hooks`) — declared as direct dependencies now, needing no new network fetch when
`pnpm install` runs. `initOpenTelemetry()` mirrors `initDatadogTracer()`'s on/off pattern: it is
a no-op unless `OTEL_TRACING_ENABLED=true`, so nothing changes for any environment that hasn't
opted in.

Wave 1 exports `getTracer()`, `withSpan()`, and a `injectTraceContext()`/`extractTraceContext()`
pair implementing W3C trace-context propagation for BullMQ job payloads. `list-score.queue.ts` /
`list-score.worker.ts` carry the one worked example wired end-to-end: the queue injects the
enqueuing request's trace context into the job payload, and the worker resumes it via
`otelContext.with(...)` before running the job, so the async hop shows up as a continuation of
one trace rather than an orphan.

Span export uses `ConsoleSpanExporter` in Wave 1, not an OTLP exporter to a real backend —
`@opentelemetry/exporter-trace-otlp-http` is not yet in the pnpm store, and choosing a tracing
backend (Honeycomb, Grafana Tempo, or routing through Datadog's own OTLP intake) is a product/
infra decision, not something to bake in silently. Swapping the exporter is a one-line change in
`buildExporter()` once that decision is made.

## Environment note
This code could not be typechecked or run in the sandbox this pass was built in — the sandbox's
shell has no network access to install `@opentelemetry/api` etc. as real `node_modules` entries
(pnpm itself isn't reachable from that shell either; see the git commit's own environment notes).
The packages are already cached in this monorepo's pnpm store from other tools' transitive
dependencies, so `pnpm install` after pulling this commit should resolve them from the local
store rather than the network — but this has not been verified end-to-end. Run
`pnpm install && pnpm --filter @skout/observability typecheck && pnpm --filter @skout/api typecheck`
before relying on this.

## Gap — explicitly not done in this pass (Wave 2)
- Trace-context propagation is wired into exactly one queue (list-score) as the worked example.
  The other ~15 BullMQ queues in `apps/api/src/workers/` and `apps/crm/src/workers/` do not yet
  inject/extract trace context.
- No OTLP exporter to a real backend — spans currently go to stdout via `ConsoleSpanExporter`
  when `OTEL_TRACING_ENABLED=true`, which is a development/verification aid, not production
  tracing.
- The Python `apps/ai` service and cross-service HTTP calls (apps/api ↔ apps/crm) are not
  instrumented — this pass only covers Node.js in-process spans and one BullMQ hop.
- Business-journey metrics and anomaly detection (silent pipeline breaks, provider degradation,
  model drift) — the vision doc's own words describe these as "larger, later additions once the
  tracing baseline exists to build them on," so they were not started here.
- §11.2 (Reliability targets) is explicitly gated on this baseline landing first per its own
  completion plan; it remains a documentation/target-setting item until real latency data exists
  to set p95/RPO/RTO targets against.
