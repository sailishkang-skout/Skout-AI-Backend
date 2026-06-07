# Provider Abstraction Layer — Apollo, Hunter, Prospeo adapters (MVP)

Internal API surface (from system components):

- `EnrichmentEngine.fetchEmail()`
- `EnrichmentEngine.fetchCompany()`
- `EnrichmentEngine.validate()`

Routing: internal graph first → external PAL on stale/missing only.

Implement in `packages/pal` when enrichment orchestrator is built (MVP month 2).
