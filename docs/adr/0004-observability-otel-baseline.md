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

## Update (Task 18 — Enterprise Completion Plan "close everything" pass)
Trace-context propagation is now wired into all 7 apps/api BullMQ queue/worker pairs (every one
that exists — apps/crm has no BullMQ/cron infra of its own, per
`apps/crm/src/workers/meeting-auto-join.worker.ts`'s own header comment, so the "and
apps/crm/src/workers/" phrasing below was inaccurate and is corrected here):
`list-score` (the original worked example), `crm-export`, `sequence-enrollment`,
`smart-list-refresh`, `webhook-delivery`, `workspace-rescore`, and `reply-tag` (which previously
enqueued via a direct `queue.add()` call with no wrapper function — Task 18 added
`enqueueReplyTagJob` for consistency with the other 6, and updated its one caller,
`inbound-reply.service.ts`).

Not covered by this update at the time it was written (now closed by the Task 33 Update
below):
- The periodic sweep workers (`alert-digest-sweep`, `blacklist-monitor`, `reminder-sweep`,
  `risk-decay-sweep`, `signal-alert-sweep`, `smart-list-refresh-sweep`, `warmup-ramp`,
  `imap-poll`'s scheduler) have no synchronous producer/request to propagate a trace *from* —
  they're self-triggered on a timer. Giving each its own root span (rather than context
  propagation, which doesn't apply here) is a smaller, separate follow-up, not done in this pass.
- Everything else in the original Gap list below remains true as written.

## Update (Task 33 — Enterprise Completion Plan "close everything" pass)
Every one of the 8 periodic sweep workers named above now wraps its tick's work in
`withSpan("<worker-name>.tick", ...)` from `packages/observability/src/otel.ts`, giving each
tick its own root span instead of tracing simply not covering these workers at all. This is
root-span creation, not context propagation (there's still no upstream request/trace to
continue from — these are genuinely self-triggered), so it's a separate mechanism from the
BullMQ queue/worker trace-context propagation Task 18 wired into the 7 request-triggered
queues. `withSpan()` is always safe to call regardless of whether `OTEL_TRACING_ENABLED` is
on — `@opentelemetry/api`'s `trace.getTracer()` returns a no-op tracer when no provider is
registered, so this is a no-op in every environment that hasn't opted into tracing, same as
everywhere else `withSpan`/`getTracer` are used in this codebase.

## Update (Task 32 — Enterprise Completion Plan "close everything" pass)
`buildExporter()` in `packages/observability/src/otel.ts` now returns a real OTLP/HTTP JSON
span exporter (`otlp-http-exporter.ts`, new) whenever `OTEL_EXPORTER_OTLP_ENDPOINT` (or the
traces-specific `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`) is set, falling back to
`ConsoleSpanExporter` when neither is — so `OTEL_TRACING_ENABLED=true` alone is still a
zero-config local/dev verification aid exactly as before, and pointing the endpoint env var at
a real collector is what now actually ships spans there, with no further code change.

This is a hand-written exporter against the documented OTLP/HTTP JSON wire protocol, not
`@opentelemetry/exporter-trace-otlp-http` — that package is still not resolvable from this
sandbox (no network to run `pnpm install` and verify it), same constraint this ADR's own
"Environment note" already discloses for `@opentelemetry/api` et al. `@opentelemetry/core`
(for `ExportResultCode`/`ExportResult`) is now a declared direct dependency of
`@skout/observability` — it was already a transitive one via `sdk-trace-base`.

Like every other change in this pass, this could not be typechecked or run against a real OTLP
collector from this sandbox — see otlp-http-exporter.ts's own doc comment for the two
deliberately-scoped simplifications (no span Links; numeric attributes always sent as
`doubleValue`) and run the same `pnpm install && pnpm --filter @skout/observability typecheck`
verification this ADR's Environment note already calls for before relying on this in production.

## Gap — explicitly not done in this pass (Wave 2), as of the original Wave-1 commit
- Trace-context propagation is wired into exactly one queue (list-score) as the worked example.
  The other ~15 BullMQ queues in `apps/api/src/workers/` and `apps/crm/src/workers/` do not yet
  inject/extract trace context. (Partially superseded — see the Task 18 Update above: 7 of the
  ~15 are now wired.)
- ~~No OTLP exporter to a real backend — spans currently go to stdout via `ConsoleSpanExporter`
  when `OTEL_TRACING_ENABLED=true`, which is a development/verification aid, not production
  tracing.~~ Closed by the Task 32 Update above — an OTLP exporter now exists and activates
  when an endpoint is configured; Console export remains the fallback default.
- The Python `apps/ai` service and cross-service HTTP calls (apps/api ↔ apps/crm) are not
  instrumented — this pass only covers Node.js in-process spans and one BullMQ hop.
- Business-journey metrics and anomaly detection (silent pipeline breaks, provider degradation,
  model drift) — the vision doc's own words describe these as "larger, later additions once the
  tracing baseline exists to build them on," so they were not started here.
- §11.2 (Reliability targets) is explicitly gated on this baseline landing first per its own
  completion plan; it remains a documentation/target-setting item until real latency data exists
  to set p95/RPO/RTO targets against.
