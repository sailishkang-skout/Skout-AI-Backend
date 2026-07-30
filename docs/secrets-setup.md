# Skout AI — Secrets Manager setup

After CDK deploy, every secret below is created with placeholder values (`replace-me`).  
**You must update each secret** before the related feature works.

Secret names use the stack prefix:

| Environment | Prefix | Example |
|-------------|--------|---------|
| Dev | `SkoutDev` | `SkoutDev/openai` |
| UAT | `SkoutUat` | `SkoutUat/clerk` |
| Prod | `SkoutProd` | `SkoutProd/openai` |

Replace `{Prefix}` below with your environment prefix.

---

## Quick update command

```bash
# Example — update OpenAI key in dev
aws secretsmanager put-secret-value \
  --secret-id SkoutDev/openai \
  --secret-string '{"OPENAI_API_KEY":"sk-..."}'
```

After updating secrets, force an ECS redeploy so tasks pick up new values:

```bash
pnpm --filter @skout/infra redeploy:dev
```

---

## Required for MVP

### 1. `SkoutDev/database` (auto-generated)

| Field | Source |
|-------|--------|
| `username`, `password` | **Auto-created by CDK** — do not change unless rotating |

Used by API ECS tasks for PostgreSQL.

---

### 2. `{Prefix}/openai`

| Field | How to get it |
|-------|----------------|
| `OPENAI_API_KEY` | [platform.openai.com](https://platform.openai.com/api-keys) → **API keys** → Create secret key |

Used by: AI service (LLM scoring, classification).

```bash
aws secretsmanager put-secret-value --secret-id SkoutDev/openai \
  --secret-string '{"OPENAI_API_KEY":"sk-proj-..."}'
```

---

### 3. `{Prefix}/clerk`

| Field | How to get it |
|-------|----------------|
| `CLERK_SECRET_KEY` | [dashboard.clerk.com](https://dashboard.clerk.com) → your app → **API Keys** → Secret key (`sk_live_…` or `sk_test_…`) |
| `CLERK_PUBLISHABLE_KEY` | Same page → Publishable key (`pk_live_…` or `pk_test_…`) |

Used by: API (JWT validation), Web (Clerk provider).

```bash
aws secretsmanager put-secret-value --secret-id SkoutDev/clerk \
  --secret-string '{"CLERK_SECRET_KEY":"sk_test_...","CLERK_PUBLISHABLE_KEY":"pk_test_..."}'
```

**Also in Clerk dashboard:** add your ALB URL to **Allowed origins** and set redirect URLs for sign-in.

---

### 4. `{Prefix}/opensearch`

| Field | How to get it |
|-------|----------------|
| `OPENSEARCH_URL` | Hosted OpenSearch provider (recommended MVP: [Bonsai](https://bonsai.io)) → cluster URL e.g. `https://abc123.bonsaisearch.net` |
| `OPENSEARCH_USERNAME` | Bonsai dashboard → cluster → **Credentials** |
| `OPENSEARCH_PASSWORD` | Same |

Used by: Search API, scraper ingestor (future).

**Bonsai steps:**
1. Sign up at bonsai.io
2. Create cluster (Sandbox free tier for dev)
3. Copy URL + username + password from cluster page

```bash
aws secretsmanager put-secret-value --secret-id SkoutDev/opensearch \
  --secret-string '{"OPENSEARCH_URL":"https://xxxx.bonsaisearch.net","OPENSEARCH_USERNAME":"xxxx","OPENSEARCH_PASSWORD":"xxxx"}'
```

> AWS OpenSearch Service is **not** provisioned by CDK (cost/complexity). Use Bonsai for MVP.

---

### 5. `{Prefix}/apollo`

| Field | How to get it |
|-------|----------------|
| `APOLLO_API_KEY` | [app.apollo.io](https://app.apollo.io) → **Settings** → **Integrations** → API → Create key |

Used by: PAL enrichment (email + company lookup).

```bash
aws secretsmanager put-secret-value --secret-id SkoutDev/apollo \
  --secret-string '{"APOLLO_API_KEY":"..."}'
```

---

### 6. `{Prefix}/hunter`

| Field | How to get it |
|-------|----------------|
| `HUNTER_API_KEY` | [hunter.io/api-keys](https://hunter.io/api-keys) → copy API key |

Used by: PAL enrichment waterfall (fallback after Apollo).

```bash
aws secretsmanager put-secret-value --secret-id SkoutDev/hunter \
  --secret-string '{"HUNTER_API_KEY":"..."}'
```

---

### 6b. `{Prefix}/unipile`

| Field | How to get it |
|-------|----------------|
| `UNIPILE_DSN` | Unipile dashboard → API → DSN for **this** API key (must match; e.g. `https://api53.unipile.com:18323`) |
| `UNIPILE_API_KEY` | Unipile dashboard → API → Access token (not the CDK `replace-me` placeholder) |

Used by: LinkedIn + WhatsApp sequence outreach, Deliverability account connect (hosted auth).

> Hosted auth returns 503 / “unavailable” when `UNIPILE_API_KEY` is still `replace-me`, or when DSN does not belong to that key.

```bash
aws secretsmanager put-secret-value --secret-id SkoutDev/unipile \
  --secret-string '{"UNIPILE_DSN":"https://apiXX.unipile.com:PORT","UNIPILE_API_KEY":"..."}'
# Then force ECS to pick up the new secret:
# bash infra/scripts/force-ecs-redeploy.sh
```

---

### 7. `{Prefix}/hubspot`

| Field | How to get it |
|-------|----------------|
| `HUBSPOT_CLIENT_ID` | [developers.hubspot.com](https://developers.hubspot.com) → **Apps** → Create app → **Auth** tab |
| `HUBSPOT_CLIENT_SECRET` | Same page |

Used by: HubSpot OAuth + contact export (Sprint 3).

**HubSpot app setup:**
1. Create private/public app
2. Redirect URL: `https://YOUR_ALB_DNS/api/v1/crm/hubspot/callback` (or your custom domain)
3. Scopes: `crm.objects.contacts.write`, `crm.objects.contacts.read`, `oauth`

```bash
aws secretsmanager put-secret-value --secret-id SkoutDev/hubspot \
  --secret-string '{"HUBSPOT_CLIENT_ID":"...","HUBSPOT_CLIENT_SECRET":"..."}'
```

---

## Required for scraping platform

### 8. `{Prefix}/scraper/linkedin`

| Field | How to get it |
|-------|----------------|
| `accounts` | JSON array of LinkedIn session credentials you control (see compliance note below) |

Example value:

```json
{
  "accounts": "[{\"id\":\"acc-1\",\"email\":\"scraper@yourcompany.com\",\"sessionCookie\":\"li_at=...\"}]"
}
```

> Store as a **string** containing JSON array, or update CDK schema to use a proper JSON object when implementing bots.

**How to get `sessionCookie`:**
1. Log into LinkedIn in a browser with a dedicated scraper account
2. DevTools → Application → Cookies → copy `li_at` value
3. Rotate regularly; never commit cookies to git

**Compliance:** Only scrape with accounts you own and within LinkedIn ToS limits.

---

### 9. `{Prefix}/scraper/proxy`

| Field | How to get it |
|-------|----------------|
| `PROXY_URL` | Residential proxy vendor e.g. [Bright Data](https://brightdata.com), [Oxylabs](https://oxylabs.io) → endpoint URL |
| `PROXY_USERNAME` | Vendor dashboard → proxy zone credentials |
| `PROXY_PASSWORD` | Same |

```bash
aws secretsmanager put-secret-value --secret-id SkoutDev/scraper/proxy \
  --secret-string '{"PROXY_URL":"http://brd.superproxy.io:22225","PROXY_USERNAME":"brd-customer-...","PROXY_PASSWORD":"..."}'
```

---

## Optional (enable when needed)

### 10. `{Prefix}/clickhouse`

| Field | How to get it |
|-------|----------------|
| `CLICKHOUSE_URL` | **Dev (self-hosted in VPC):** auto-set on `cdk deploy SkoutDev-Compute` → CloudFormation output `ClickHouseUrl`, or DNS `clickhouse.skoutdev.local:8123`. **Local:** `http://skout:skout@localhost:8123/skout` via `docker compose up -d clickhouse`. **External:** [clickhouse.cloud](https://clickhouse.cloud) connection string. |

Used for: workspace analytics events (`skout_events` table).

---

### 11. `{Prefix}/sentry`

| Field | How to get it |
|-------|----------------|
| `SENTRY_DSN` | [sentry.io](https://sentry.io) → Project → **Settings** → Client Keys (DSN) |

---

### 12. `{Prefix}/posthog`

| Field | How to get it |
|-------|----------------|
| `POSTHOG_API_KEY` | [posthog.com](https://posthog.com) → Project → **Project API Key** |

---

## GitHub secrets (not in AWS Secrets Manager)

Set these in **GitHub → Settings → Environments**:

| Environment | Secret / Variable | How to get it |
|-------------|-------------------|---------------|
| `dev` | `AWS_DEPLOY_ROLE_ARN_DEV` | CDK output `GitHubDeployRoleArn` from `SkoutDev-Registry` stack |
| `uat` | `AWS_DEPLOY_ROLE_ARN_UAT` | Same from `SkoutUat-Registry` |
| `production` | `AWS_DEPLOY_ROLE_ARN_PROD` | Same from `SkoutProd-Registry` |
| `dev` | var `DEV_API_URL` | CDK output `LoadBalancerDns` → `http://{dns}` |
| `uat` | var `UAT_API_URL` | CDK output from UAT deploy |

```bash
aws cloudformation describe-stacks --stack-name SkoutDev-Registry \
  --query "Stacks[0].Outputs[?OutputKey=='GitHubDeployRoleArn'].OutputValue" --output text
```

---

## What CDK auto-creates vs what you provide

| Resource | CDK | You provide |
|----------|-----|-------------|
| VPC, RDS, Redis, S3, ECS, ALB | ✅ | — |
| ECR repos (api, ai, web, workers, scrapers) | ✅ | Docker images via CI |
| Secrets Manager **shells** | ✅ | Real credential values |
| SQS scrape schedule + EventBridge | ✅ | — |
| CloudWatch alarms + SNS topic | ✅ | `ALERT_EMAIL` env var at synth (optional) |
| OpenSearch cluster | ❌ | Bonsai (external) |
| Clerk, Apollo, Hunter, HubSpot apps | ❌ | Vendor dashboards |
| Scraper proxies | ❌ | Proxy vendor |
| Worker ECS services | ❌ (next story) | Worker images when built |
| HTTPS custom domain | ❌ (optional) | Route53 + `DEV_DOMAIN_NAME` |

---

## Checklist after first deploy

- [ ] `SkoutDev/openai` — OpenAI API key
- [ ] `SkoutDev/clerk` — Clerk keys + dashboard redirect URLs
- [ ] `SkoutDev/opensearch` — Bonsai cluster credentials
- [ ] `SkoutDev/apollo` — Apollo API key
- [ ] `SkoutDev/hunter` — Hunter API key
- [ ] `SkoutDev/hubspot` — HubSpot OAuth app (Sprint 3)
- [ ] `SkoutDev/scraper/proxy` — before scraping goes live
- [ ] `SkoutDev/scraper/linkedin` — before LinkedIn bot goes live
- [ ] GitHub `AWS_DEPLOY_ROLE_ARN_DEV` + `DEV_API_URL`
- [ ] Force ECS redeploy after secrets update
