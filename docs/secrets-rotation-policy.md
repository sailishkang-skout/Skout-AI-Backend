# Secrets rotation policy

§11.1 (Enterprise Completion Plan). `docs/secrets-setup.md` documents how to populate each
secret the first time, per environment. It says nothing about when or how to rotate one
afterward — that gap is what this document closes. It's a policy document, not a script: this
sandbox has no AWS credentials and no way to actually rotate a production secret, so nothing
here has been executed against a real environment. It defines cadence, ownership, and
procedure so a human operator can run rotation on schedule, and names the one secret
(`INTEGRATION_ENCRYPTION_KEY`) whose rotation is not a routine key swap.

## Scope

Every secret listed in `docs/secrets-setup.md`, plus the ones added since that doc was last
updated: `STEP_UP_SIGNING_SECRET`, `ADMIN_IMPORT_SECRET`, `TRACKING_SIGNING_SECRET`,
`MEETING_BOT_WEBHOOK_SECRET`, `MEETING_RSVP_WEBHOOK_SECRET`, `RAZORPAY_WEBHOOK_SECRET`,
`TWILIO_AUTH_TOKEN`, `TELNYX_API_KEY`, `SMTP_PASSWORD` / `MEETING_INVITE_SMTP_PASSWORD`. If a
secret exists in `apps/*/src/config/env.ts` and isn't in either document, that's a gap in the
inventory, not evidence the secret is exempt from this policy — treat "not listed" as "not yet
classified," file it under the tier its blast radius implies, and add it to the table below.

## Tiers

Rotation cadence and break-glass urgency scale with blast radius, not with how the secret is
labeled. Four tiers:

**Tier 1 — platform-wide compromise.** A leak lets an attacker act as Skout itself against
every workspace: forge sessions, decrypt every tenant's stored integration credentials, or
move workspace funds. Rotate every 90 days on schedule; rotate immediately (see Break-glass
below) on any suspected exposure, regardless of where in the 90-day window it falls.

| Secret | Why Tier 1 |
|---|---|
| `DATABASE_PASSWORD` | Full read/write on every workspace's data. |
| `CLERK_SECRET_KEY` | Can mint/validate sessions for any user in any workspace. |
| `INTEGRATION_ENCRYPTION_KEY` | Decrypts every stored third-party credential for every workspace (OAuth tokens, IMAP passwords, etc.). See the special procedure below — this one is not a routine swap. |
| `STEP_UP_SIGNING_SECRET` | Forges step-up re-authentication proof for any privileged action once `STEP_UP_ENFORCEMENT_ENABLED` is on (see `packages/auth/src/step-up.ts`). |
| `ADMIN_IMPORT_SECRET` | Bypasses normal ingestion paths to write records directly into a workspace. |
| `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET` | Payment-provider credentials; a forged webhook can fabricate a paid state. |

**Tier 2 — single-integration compromise.** A leak lets an attacker act as Skout against one
third-party vendor (send email as Skout, read/write CRM records via an OAuth app, place calls
on Skout's account) but doesn't reach tenant data directly. Rotate every 180 days.

| Secret | Why Tier 2 |
|---|---|
| `HUBSPOT_CLIENT_SECRET`, `GOOGLE_CLIENT_SECRET`, `MICROSOFT_CLIENT_SECRET` | OAuth app secrets — a leak lets an attacker impersonate Skout's OAuth app to any customer who has authorized it. |
| `TRACKING_SIGNING_SECRET` | Forges tracking/unsubscribe tokens; falls back to `INTEGRATION_ENCRYPTION_KEY` if unset — see the coupling note below. |
| `MEETING_BOT_API_KEY`, `MEETING_BOT_WEBHOOK_SECRET`, `MEETING_RSVP_WEBHOOK_SECRET` | Meeting-bot vendor account + webhook authenticity. |
| `TWILIO_AUTH_TOKEN`, `TELNYX_API_KEY` | Can place calls / send SMS billed to Skout's account. |
| `SMTP_PASSWORD`, `MEETING_INVITE_SMTP_PASSWORD` | Can send email as Skout's sending domain (deliverability/reputation risk, not just cost). |
| `CRM_SECRETS_PREFIX`-scoped secrets | Same reasoning as the OAuth secrets above — CRM-bridge credentials. |

**Tier 3 — vendor API cost/quota abuse.** A leak lets an attacker spend Skout's quota/budget
with a third-party data or AI vendor, but touches no tenant data and can't act as Skout toward
a customer. Rotate every 365 days, or immediately if usage/billing alerts show anomalous
consumption.

| Secret | Why Tier 3 |
|---|---|
| `OPENAI_API_KEY`, `OPENROUTER_API_KEY` / `OPEN_ROUTER_API_KEY` | LLM usage billed to Skout. |
| `HUNTER_API_KEY`, `MILLIONVERIFIER_API_KEY`, `ZEROBOUNCE_API_KEY`, `NEVERBOUNCE_API_KEY`, `PDL_API_KEY`, `REVENUEBASE_API_KEY`, `EXPLORIUM_API_KEY`, `CORESIGNAL_API_KEY`, `DATAGMA_API_KEY`, `KASPR_API_KEY`, `LUSHA_API_KEY`, `CONTACTOUT_API_KEY`, `COGNISM_API_KEY`, `APOLLO_API_KEY`, `OPENCORPORATES_API_KEY`, `UNIPILE_API_KEY` | Enrichment/data-vendor quota, billed per call. |
| `POSTHOG_API_KEY`, `DD_API_KEY`, `SENTRY_DSN` | Observability vendor ingest — a leak lets someone else's events land in Skout's project (noise/cost), not a tenant-data leak. |
| `OPENSEARCH_PASSWORD` | Search cluster credentials — scoped to search infrastructure, not raw tenant records. |

**Tier 4 — scraping infrastructure.** LinkedIn session cookies and residential-proxy
credentials (`{Prefix}/scraper/linkedin`, `{Prefix}/scraper/proxy`). These already have a
distinct, shorter operational rotation cadence for reasons unrelated to security compromise —
LinkedIn session cookies expire and get flagged well inside 90 days regardless of exposure —
and `docs/secrets-setup.md` already says "rotate regularly." This policy doesn't change that;
it exists here only so the inventory is complete. Follow the scraping-platform runbook for
cadence, not this document.

## The `INTEGRATION_ENCRYPTION_KEY` special case

Every other secret in this policy is an external credential: rotating it means generating a
new value and telling the vendor (or Clerk, or the database) to accept it — the old value
simply stops working. `INTEGRATION_ENCRYPTION_KEY` is different: it's a symmetric key Skout
itself uses to encrypt every stored third-party credential at rest (OAuth tokens, IMAP
passwords, etc., per `apps/crm/src/config/env.ts` and its callers). Swapping it to a new value
without a migration step makes every already-encrypted row **permanently unreadable** — not a
security improvement, an outage and a data-loss incident.

Rotating it safely requires a re-encryption migration: decrypt every affected row under the
old key, re-encrypt under the new key, and only then remove the old key from the environment.
That migration is:

```bash
OLD_INTEGRATION_ENCRYPTION_KEY=<old> NEW_INTEGRATION_ENCRYPTION_KEY=<new> \
  pnpm --filter @skout/db rotate-integration-encryption-key
```

During cutover, keep the previous key as `INTEGRATION_ENCRYPTION_KEY_PREVIOUS` and use
`decryptSecretWithFallback` from `@skout/shared` so reads succeed for rows not yet rewritten.
After the script reports `failed=0`, drop the previous key from the environment.

`TRACKING_SIGNING_SECRET` falls back to `INTEGRATION_ENCRYPTION_KEY` when unset (see
`apps/api/src/config/env.ts`'s doc comment on it). An environment relying on that fallback
inherits the same rotation constraint — set `TRACKING_SIGNING_SECRET` explicitly if it needs
to rotate on a schedule independent of the encryption key.

## Procedure (routine rotation, Tiers 1–3)

1. Generate the new credential at the vendor (or, for `STEP_UP_SIGNING_SECRET` /
   `ADMIN_IMPORT_SECRET` / `TRACKING_SIGNING_SECRET`, a new random value — these aren't
   vendor-issued).
2. Update the value in AWS Secrets Manager per environment, following the
   `aws secretsmanager put-secret-value` pattern in `docs/secrets-setup.md`.
3. Force an ECS redeploy so running tasks pick up the new value (`pnpm --filter @skout/infra
   redeploy:dev`, or the equivalent for uat/prod — see `docs/secrets-setup.md`).
4. Confirm the feature the secret backs still works post-redeploy (e.g., send a test email
   after rotating `SMTP_PASSWORD`; confirm a call connects after rotating `TWILIO_AUTH_TOKEN`).
5. Revoke/delete the old credential at the vendor once step 4 confirms the new one is live —
   don't leave both valid longer than the overlap needed for a safe cutover.
6. Record the rotation date somewhere durable (this policy doesn't mandate a specific tracker,
   but "nobody knows when this last rotated" is exactly the state this document exists to end
   — a shared changelog, ticket, or the secret's own AWS Secrets Manager rotation metadata all
   satisfy this).

## Break-glass (suspected compromise)

Any suspected exposure of a Tier 1 or Tier 2 secret — a credential pasted somewhere public, a
laptop with access lost, a vendor breach notice — triggers immediate rotation regardless of
where the secret sits in its normal cadence. Follow the same procedure above, but skip the
overlap in step 5: revoke the old credential as soon as the new one is confirmed live, don't
wait for a convenient maintenance window. For `INTEGRATION_ENCRYPTION_KEY` specifically,
compromise is a genuinely harder incident — see the special case above — and needs the
re-encryption migration built first; that migration should be treated as break-glass-ready
tooling, not something to design for the first time during an active incident.

## Ownership

This document sets policy; it doesn't assign a named individual or on-call rotation to execute
it — that's an organizational decision this sandbox has no authority to make, consistent with
this engagement's earlier disclosed limitation that named owners and due dates (§13, §18) need
a human to fill in, not code. Whoever owns production secrets access today is the de facto
owner until a role is explicitly assigned.

## What this document does not do

It does not automate rotation — there is no scheduled job that rotates a secret and no
mechanism enforcing the 90/180/365-day cadences above; they're policy for a human (or a future
scheduled task) to follow, not code that runs them. It does not cover the Tier 4 scraping
credentials' cadence, which already has separate operational guidance in
`docs/secrets-setup.md`. The `INTEGRATION_ENCRYPTION_KEY` re-encryption path is implemented
as `pnpm --filter @skout/db rotate-integration-encryption-key` (see § above); operators still
run it manually on the Tier 1 cadence or for break-glass.
