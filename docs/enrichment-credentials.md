# Enrichment Provider Credentials — where to add them

The lead-enrichment feature (PAL waterfall) calls third-party provider APIs.
Each capability uses a **live adapter when its key is present** and a deterministic
**stub adapter otherwise** — so the app runs end-to-end with zero keys, and you can
turn providers on one at a time.

## Providers, keys, and what they power

| Capability | Provider | Env var | Get a key |
|------------|----------|---------|-----------|
| Email finder | Hunter.io | `HUNTER_API_KEY` | https://hunter.io → Dashboard → API |
| Email verify (bulk first-pass) | MillionVerifier | `MILLIONVERIFIER_API_KEY` | https://app.millionverifier.com → API |
| Email verify (accuracy gate) | ZeroBounce | `ZEROBOUNCE_API_KEY` | https://www.zerobounce.net → API |
| Email verify (alt accuracy gate) | NeverBounce | `NEVERBOUNCE_API_KEY` | https://app.neverbounce.com → API keys |
| Company firmographics | People Data Labs | `PDL_API_KEY` | https://dashboard.peopledatalabs.com → API keys |
| Company firmographics (fallback) | RevenueBase | `REVENUEBASE_API_KEY` | https://revenuebase.ai |
| Company firmographics (fallback) | Explorium | `EXPLORIUM_API_KEY` | https://explorium.ai |
| Company firmographics (fallback) | Coresignal | `CORESIGNAL_API_KEY` | https://coresignal.com |
| Phone (score-gated, lead score > 80) | Datagma | `DATAGMA_API_KEY` | https://datagma.com → API |
| Phone (EMEA fallback) | Cognism | `COGNISM_API_KEY` | https://cognism.com |
| Tier 1 registry data | OpenCorporates | `OPENCORPORATES_API_KEY` | https://opencorporates.com/api_accounts/new |

Selection rules (see `packages/pal/src/config.ts`):
- Email finder → Hunter if `HUNTER_API_KEY`, else stub.
- Email verify → whichever of MillionVerifier / ZeroBounce / NeverBounce keys are set
  (run in that order). If only Hunter is set, Hunter's verifier is used. Else stub.
- Firmographics → PDL → RevenueBase → Explorium → Coresignal (whichever keys are set).
- Phone → Datagma → Cognism (whichever keys are set).

---

## 1) Local development

Add the keys to your local `.env` (copy from `.env.example`). Only fill the ones you have:

```bash
cp .env.example .env
# then edit .env:
HUNTER_API_KEY=...
MILLIONVERIFIER_API_KEY=...
ZEROBOUNCE_API_KEY=...
NEVERBOUNCE_API_KEY=...
PDL_API_KEY=...
REVENUEBASE_API_KEY=...
EXPLORIUM_API_KEY=...
CORESIGNAL_API_KEY=...
DATAGMA_API_KEY=...
COGNISM_API_KEY=...
SCRAPE_BUCKET=...
OPENCORPORATES_API_KEY=...
```

Restart `pnpm dev`. With no keys set, the stub adapters are used automatically.

---

## 2) Deployed environments (AWS Secrets Manager)

Keys are stored in two secrets and injected into the API container as env vars by
the CDK compute stack (`infra/lib/stacks/compute-stack.ts`).

| Secret path | Keys it holds |
|-------------|---------------|
| `<Prefix>/hunter` | `HUNTER_API_KEY` |
| `<Prefix>/enrichment-providers` | `MILLIONVERIFIER_API_KEY`, `ZEROBOUNCE_API_KEY`, `NEVERBOUNCE_API_KEY`, `PDL_API_KEY`, `REVENUEBASE_API_KEY`, `EXPLORIUM_API_KEY`, `CORESIGNAL_API_KEY`, `DATAGMA_API_KEY`, `COGNISM_API_KEY`, `OPENCORPORATES_API_KEY` |

`<Prefix>` is the stack prefix: **`SkoutDev`** (dev), `SkoutUat`, or `SkoutProd`.

The secrets are created with `replace-me` placeholders on first deploy
(`infra/lib/constructs/skout-app-secrets.ts`). Fill them in after deploying:

```bash
# Hunter (single key)
./scripts/put-secret.sh SkoutDev hunter '{"HUNTER_API_KEY":"..."}'

# All other providers (one JSON object)
./scripts/put-secret.sh SkoutDev enrichment-providers '{
  "MILLIONVERIFIER_API_KEY":"...",
  "ZEROBOUNCE_API_KEY":"...",
  "NEVERBOUNCE_API_KEY":"...",
  "PDL_API_KEY":"...",
  "REVENUEBASE_API_KEY":"...",
  "EXPLORIUM_API_KEY":"...",
  "CORESIGNAL_API_KEY":"...",
  "DATAGMA_API_KEY":"...",
  "COGNISM_API_KEY":"...",
  "OPENCORPORATES_API_KEY":"..."
}'
```

> Put **all** provider keys in the single `enrichment-providers` JSON in one call —
> `put-secret-value` replaces the whole secret value. Include every key you want kept.

After updating a secret, redeploy or force a new ECS deployment so tasks pick up the
new values:

```bash
aws ecs update-service --cluster <cluster> --service <api-service> --force-new-deployment
```

(Or just `pnpm infra:deploy:dev` if other infra changed.)

---

## Related (already-provisioned) secrets

These existed before and back other parts of the platform:

| Secret path | Used by |
|-------------|---------|
| `<Prefix>/openai` | `apps/ai` (LLM scoring/classification) |
| `<Prefix>/opensearch` | corpus search + ingestor `_bulk` |
| `<Prefix>/scraper/linkedin` | LinkedIn scraper bot accounts |
| `<Prefix>/scraper/proxy` | scraper proxy pool |
| `<Prefix>/apollo`, `<Prefix>/hubspot` | other integrations |

So: LinkedIn scraping and OpenSearch ingestion credentials go in the existing
`scraper/*` and `opensearch` secrets respectively — same `put-secret.sh` pattern.
