# ADR-001: Enrichment Integration - LinkedIn Prospector v0.8.3

## Status

Accepted

## Context

The LinkedIn EnrichmentTool prototype needed to be folded into Skout's production monorepo with proper security, tenancy, and compliance controls. This foundational integration enables all other enrichment functionality within Skout AI.

## Decision

We integrate the LinkedIn enrichment capabilities into Skout's existing architecture following these patterns:

### Folder Structure

- **Routes**: `apps/api/src/routes/enrichment.*.ts` - All enrichment API endpoints
- **Schema**: `packages/db/src/schema/` - Database schemas for enrichment functionality
  - `evidence.ts` - Evidence ledger for storing enrichment data with source, capture time, and confidence scores
  - `enrichment.ts` - Enrichment-specific tables including workspace-scoped credit tracking
  - `crm.ts` - Updated with employmentStatus enum to track discovery lifecycle
- **Services**: `apps/api/src/services/enrichment/` - Core enrichment business logic
- **Workers**: `apps/api/src/workers/` - Background processing for enrichment jobs
- **Extension**: `apps/chrome-extension/` - Skout AI Prospector extension with LinkedIn scraping capabilities

### Alignment with Existing Skout Services

1. **Evidence Ledger**: All enrichment data is pinned to the `evidence_ledger` table, following the same pattern as other AI-generated claims. Each evidence row includes:
   - `source`: Identifies the origin of the data (e.g., "linkedin_capture", "ai_score")
   - `observedAt`: Capture time of the enrichment data
   - `confidence`: Score between 0 and 1 representing data quality
   - `workspaceId`: Enforces tenancy - all data is scoped to a specific workspace

2. **Identity Merge**: Enriched prospect data is integrated with Skout's existing identity merge system to prevent duplicates and maintain a single source of truth for each contact.

3. **Prospect Schema**: Enrichment capabilities extend the existing prospect schema with additional signals and metadata from LinkedIn.

### Prototype → Skout Equivalents Reconciliation Map

| Prototype Concept | Skout Production Equivalent |
| ------------------- | ------------------------------ |
| Evidence storage | `evidence_ledger` table with full audit trail |
| Extension capture | Skout AI Prospector v0.8.3 chrome extension |
| Per-user API keys | Workspace-scoped Clerk authentication with RBAC |
| Basic rate limits | Enterprise-grade rate limiting + CORS allowlist |
| No tenancy | Full workspace isolation with foreign key constraints |
| Simple error handling | Integrated with Skout's existing error tracking and observability |

## Consequences

### Security

- All enrichment routes require authenticated workspace members with the `enrichment:capture` permission
- Cross-workspace access is blocked at the database level via `workspaceId` foreign keys
- Secrets remain server-side only, never exposed to the frontend or extension
- CORS is restricted to trusted origins only

### Compliance

- LinkedIn capture bounds enforced: 10 pages / 250 leads max per capture session
- Audit events logged for all enrichment operations: capture, export, delete, re-enrich, provider changes
- URL fabrication prevented via `normalizeProfileUrl` that only creates valid LinkedIn `/in/` links

### Tenancy

- All new database tables include `workspaceId` foreign key
- Drizzle ORM queries automatically scope to the authenticated workspace
- Cross-workspace access attempts are logged and blocked

### Performance

- Enrichment jobs run asynchronously to avoid blocking API responses
- Database indexes optimized for workspace-scoped queries
- Rate limits prevent abuse of enrichment resources

## Implementation Timeline

1. ✅ Database schema migration (Prisma → Drizzle) with workspace IDs
2. ✅ Core auth middleware updated with enrichment permissions
3. 🚧 Enrichment routes secured with RBAC and workspace scoping
4. 🚧 Audit logging implemented for all enrichment operations
5. 🚧 Frontend integration with Skout's shell
6. 🚧 OpenAPI documentation published
7. 🚧 Operational runbook created with compliance alerts

## Related Work

- ENR-01: Security Boundary, Tenancy & Port (this work)
- Evidence ledger ADR-0005: AI Claim Evidence Pinning
- SSO/SCIM ADR-0006: SSO SCIM Stage 6
