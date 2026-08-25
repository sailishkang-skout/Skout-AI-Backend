# Warm-Up Tool — Testing Guide (Enterprise v1)

This guide covers local smoke tests, SkoutDev deploy verification, the Fastify
proxy, every major product feature, cross-feature hooks, security checks, and
ops controls.

Related code:

- Service: `Skout-Warm-Up-Tool` (port **3010**)
- Proxy: Skout API `/api/v1/warmup-tool/*`
- UI: Frontend **Outreach → Email Warm-up**
- Infra: `infra/lib/stacks/warmup-tool-stack.ts`
- Migrations: `scripts/ecs-run-warmup-tool-migrations.sh`

---

## 1. Local (Warm-Up Tool alone)

```bash
cd "Skout-Warm-Up-Tool"
npm run db:up          # Postgres :5433, Redis :6380
cp .env.example .env   # set ENCRYPTION_KEY, API_KEY_PEPPER (≥32 chars)
# optional: PLATFORM_PROVISIONING_KEY (≥32) for Skout platform provisioning
npm run migrate:up
npm run bootstrap:tenant "Local Dev" -- --credential-name "local"
# save the printed swu_ key

npm run dev
# other terminals:
npm run worker:dev
npm run inbound:dev
npm run classification:dev
npm run policy:dev
```

Smoke:

| Check | Command / expectation |
|--------|------------------------|
| Liveness | `GET http://localhost:3010/health` → 200 |
| Readiness | `GET http://localhost:3010/readiness` → 200 |
| Auth | `GET /api/v1/mailboxes` without Bearer → 401 |
| Auth | same with `Authorization: Bearer swu_…` → 200 |
| Provision | `POST /api/v1/internal/provision-tenant` with `PLATFORM_PROVISIONING_KEY` → 201 + `apiKey` |

---

## 2. Local (Skout API proxy)

In Backend `.env`:

```env
WARMUP_TOOL_SERVICE_URL=http://localhost:3010
WARMUP_TOOL_PLATFORM_PROVISIONING_KEY=<same as Warm-Up PLATFORM_PROVISIONING_KEY>
INTEGRATION_ENCRYPTION_KEY=<any ≥32 secret>
```

Start Skout API + Frontend. With a Clerk (or stub) session:

1. Open `/app/warmup` — overview loads.
2. Open Network tab — only `/api/v1/warmup-tool/...` calls; **no** `swu_` in request/response bodies after create.
3. First mailbox list call auto-provisions a Warm-Up tenant for the workspace (check API logs).

---

## 3. SkoutDev deploy

1. Deploy CDK with registry + WarmupTool stack (first time use `-c warmupToolBootstrap=true` so desiredCount stays 0 until DB exists).
2. Ensure Secrets Manager `SkoutDev/warmup-tool` has real `ENCRYPTION_KEY`, `API_KEY_PEPPER`, `PLATFORM_PROVISIONING_KEY` (not `replace-me`).
3. Build/push image to `skout-dev-warmup-tool`.
4. Run `bash scripts/ecs-run-warmup-tool-migrations.sh SkoutDev`.
5. Redeploy without bootstrap; confirm services:
   - `warmup-tool-api`
   - `warmup-tool-worker`
   - `warmup-tool-inbound`
   - `warmup-tool-classification`
   - `warmup-tool-policy`
6. Confirm API task env: `WARMUP_TOOL_SERVICE_URL=http://warmup-tool.<ns>:3010` and provisioning secret.
7. Force redeploy `api` + `web`.

ECS health: `warmup-tool-api` CloudWatch `/skout/dev/warmup-tool-api` shows listen on 3010; CloudMap DNS resolves inside VPC.

---

## 4. Proxy checks (authenticated browser / curl with Clerk JWT)

| Path | Expect |
|------|--------|
| `GET /api/v1/warmup-tool` | Proxies upstream `/health` |
| `GET /api/v1/warmup-tool/mailboxes` | 200 `{ mailboxes: [...] }` |
| `POST /api/v1/warmup-tool/mailboxes` | Body **must** use `emailAddress` + `provider` (see below) |
| `POST /api/v1/warmup-tool/domains` | Body **must** use `domainName` |
| OAuth callbacks | Public (no Clerk) |
| `POST /api/v1/warmup-tool/integration-events/poll` | Advances cursor in `warmup_tool_sync_state` |

### Correct create payloads (common 400 cause)

```bash
# Mailbox — NOT email/address
curl -X POST "$API/api/v1/warmup-tool/mailboxes" \
  -H "authorization: Bearer $CLERK_JWT" -H "content-type: application/json" \
  --data '{"emailAddress":"you@company.com","provider":"GMAIL","timezone":"UTC"}'

# Domain — NOT domain/name
curl -X POST "$API/api/v1/warmup-tool/domains" \
  -H "authorization: Bearer $CLERK_JWT" -H "content-type: application/json" \
  --data '{"domainName":"company.com","provider":"UNKNOWN"}'

# Domain verify — DNS evidence required (never empty {})
curl -X POST "$API/api/v1/warmup-tool/domains/$DOMAIN_ID/verify" \
  -H "authorization: Bearer $CLERK_JWT" -H "content-type: application/json" \
  --data '{"mx":"PASS","spf":"PASS","dkim":"PASS","dmarc":"PASS"}'
```

---

## 5. Feature guide — what it is, why it matters, how to test

Work through **Outreach → Email Warm-up**. Typical path: Mailboxes → Control → Health → Domains → Pools → Network → Kill switches.

### Mailboxes (`/warmup/mailboxes`)

**What:** Register a Gmail or Microsoft 365 sending identity, connect OAuth, enable/disable it.  
**Why:** Warm-up can only send from connected mailboxes. Without this, volume never ramps and reputation stays unproven.  
**Test:**
1. Create with a real address + provider.
2. Click **Connect Google/Microsoft** (needs OAuth secrets; otherwise authorization URL may fail).
3. **Enable**, then confirm it appears in Control’s mailbox dropdown.
4. Wrong body fields (`email` / `address`) → 400 validation.

### Warm-up control (`/warmup/control`)

**What:** Start / pause / resume / stop the ramp; inspect status and scheduler decisions.  
**Why:** Operators control how aggressively a mailbox warms. Pause when complaints/bounces rise; stop when done or migrating.  
**Test:** Select an enabled mailbox → Start → Status JSON updates → Pause → Resume → Stop (confirm dialog).

### Health and risk (`/warmup/health`)

**What:** Intelligence, risk, and reputation panels for one mailbox.  
**Why:** Tells you whether increasing send volume is safe — feeds readiness hints in Sequences / Deliverability.  
**Test:** Select mailbox → three panels load (empty/null OK for a brand-new mailbox). Fail-open if service down elsewhere.

### Conversations and signals (`/warmup/conversations`)

**What:** Warm-up threads, classifications, policy signals; poll integration events into Skout.  
**Why:** Shows engagement quality (replies, spam, etc.) and pushes CRM-facing events with a durable cursor.  
**Test:** Filter by mailbox → open a conversation id → Poll integration events → cursor advances (`nextCursor`).

### Domains (`/warmup/domains`)

**What:** Customer apex domains + DNS auth evidence (MX/SPF/DKIM/DMARC).  
**Why:** Domains with broken auth burn warm-up effort; fixing DNS protects deliverability for all mailboxes on that domain.  
**Test:** Add `domainName` → **Verify DNS** with evidence → statuses update on the card.

### Pools (`/warmup/pools`)

**What:** Named sending-identity pools and pool health.  
**Why:** Groups mailboxes for allocation (share load / isolate risk) instead of managing one-by-one.  
**Test:** Create pool by name → Health for that pool (membership may be empty until mailboxes are added via API).

### Partner network (`/warmup/network`)

**What:** Read-only health of the warm-up recipient network (opaque partner domains/mailboxes).  
**Why:** Warm-up needs healthy counterparties to exchange mail with; network issues explain stalled ramps.  
**Test:** Open page → three panels return JSON (counts/status). No create UI in v1.

### Kill switches (`/warmup/operations`)

**What:** Activate scoped pause of **new** provider sends (GLOBAL / PROVIDER / NETWORK / TENANT / DOMAIN / MAILBOX).  
**Why:** Emergency brake during provider outages, abuse, or policy incidents without tearing down mailboxes.  
**Test:** Enter reason (≥3 chars) → Activate TENANT with confirm → switch appears in list. Workers should skip/pause new sends.

| Area | Route | Payload / UI notes |
|------|--------|-------------------|
| Overview | `/warmup` | Flow callout + section cards |
| Mailboxes | `/warmup/mailboxes` | `emailAddress`, `provider` |
| Control | `/warmup/control` | Lifecycle buttons + decisions |
| Health | `/warmup/health` | Per-mailbox panels |
| Conversations | `/warmup/conversations` | Poll button |
| Domains | `/warmup/domains` | `domainName` + DNS evidence |
| Pools | `/warmup/pools` | `{ name }` |
| Network | `/warmup/network` | Read-only |
| Kill switches | `/warmup/operations` | `{ scope, reason }` min 3 chars |


## 6. Cross-feature

| Surface | Expect |
|---------|--------|
| Deliverability inbox cards | When Warm-Up Tool has a matching email, show “Email Warm-up” badge + Open link |
| Email Intelligence overview | Card linking to `/warmup` (intel domain warm-up scaffold remains) |
| Sequences | “Warm-up readiness” link + copy in description |
| Service down | UI/API fail open on inbox list enrichment; proxy returns 502/503 with clear error |

---

## 7. Security

1. Browser Network tab: responses for credential issue/rotate **must not** include plaintext `apiKey`.
2. Workspace isolation: Workspace A’s mailboxes must not appear when logged into Workspace B (separate Warm-Up tenants via provisioning).
3. Unauthenticated `GET /api/v1/warmup-tool/mailboxes` → 401 from Skout API.
4. Provisioning endpoint on Warm-Up Tool rejects wrong Bearer.

---

## 8. Ops

1. Activate a **TENANT** kill switch → new provider sends pause (workers log retryable failure).
2. Restart `warmup-tool-worker` ECS task → recovers and continues leasing.
3. Confirm nightly scale-to-zero does **not** include `warmup-tool-*` services (same as email-intel).

---

## 9. OAuth (optional, when Google/Microsoft configured)

Set on Warm-Up Tool task (all three per provider):

- `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` / `GOOGLE_REDIRECT_URI=https://<public-api>/api/v1/warmup-tool/oauth/google/callback`
- Same pattern for Microsoft

Then Connect Google/Microsoft from Mailboxes UI and complete consent; mailbox connection snapshot should update.

---

## 10. Sign-off checklist

- [ ] Local health/readiness + bootstrap key
- [ ] Dev ECS services healthy + migrations applied
- [ ] Proxy + auto-provision per workspace
- [ ] All 9 UI sections exercised
- [ ] Deliverability / Intelligence / Sequences links
- [ ] No `swu_` leakage to browser
- [ ] Cross-workspace isolation spot-check
- [ ] Kill switch smoke
