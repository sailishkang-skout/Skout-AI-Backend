import type { FastifyInstance } from "fastify";
import { sql } from "drizzle-orm";
import type { Db } from "@skout/db";
import { getMemberPermissions } from "@skout/auth";
import type { Env } from "../config/env.js";
import { requireAnyCopsPermission } from "../services/cops-platform.service.js";

/**
 * connected: keys and webhook secret in place AND the provider has sent this workspace a status update.
 * unverified: fully set up, but no status update has arrived yet, so the round trip is not proven.
 * partial: can call the provider but hears nothing back.
 */
export type ProviderStatus = "connected" | "unverified" | "partial" | "sandbox" | "not_configured";

/** "Connected" only once the provider has called back; keys alone prove nothing. */
export function webhookProven(configured: ProviderStatus, lastEventAt: Date | string | null | undefined, provider: string): { status: ProviderStatus; missing: string[] } {
  if (configured !== "connected" || lastEventAt) return { status: configured, missing: [] };
  return { status: "unverified", missing: [`No status update from ${provider} has reached this workspace yet; check its webhook points to this server`] };
}

export interface ProviderHealth {
  key: "payments" | "esign" | "email" | "slack" | "teams";
  provider: string | null;
  status: ProviderStatus;
  /** What is missing, in words an admin can act on. Never a secret or a URL. */
  missing: string[];
  last_event_at: string | null;
  /** Provider events (payments, e-sign) or sends (email) in the last 7 days. */
  events_7d: number;
  failures_7d: number;
}

type Counts = { last_at: Date | string | null; total: number | string; failed: number | string };
const iso = (v: Date | string | null) => (v ? new Date(v).toISOString() : null);

/** Failures are events Skout could not match or process; ignored, no_change and stale are expected outcomes (late or out-of-order events). */
/** Which providers are configured (from the deployment's env, never echoed) and what they last did. */
export async function loadIntegrationsStatus(db: Db, config: Env, workspaceId: string): Promise<ProviderHealth[]> {
  const [row] = (await db.execute(sql`
    select
      (select row_to_json(p) from (select max(received_at) as last_at, count(*) filter (where received_at > now() - interval '7 days') as total,
         count(*) filter (where received_at > now() - interval '7 days' and outcome in ('unmatched', 'error', 'failed', 'invalid')) as failed
         from payment_provider_events where workspace_id = ${workspaceId}) p) as payments,
      (select row_to_json(e) from (select max(received_at) as last_at, count(*) filter (where received_at > now() - interval '7 days') as total,
         count(*) filter (where received_at > now() - interval '7 days' and outcome in ('unmatched', 'error', 'failed', 'invalid')) as failed
         from signature_events where workspace_id = ${workspaceId}) e) as esign,
      (select row_to_json(m) from (select max(created_at) as last_at, count(*) filter (where created_at > now() - interval '7 days') as total,
         count(*) filter (where created_at > now() - interval '7 days' and (status = 'failed' or bounced_at is not null)) as failed
         from cops_onboarding_email_sends where workspace_id = ${workspaceId}) m) as email,
      (select slack_webhook_url is not null and slack_webhook_url <> '' from workspaces where id = ${workspaceId}) as slack,
      (select teams_webhook_url is not null and teams_webhook_url <> '' from workspaces where id = ${workspaceId}) as teams`)) as unknown as Array<{
    payments: Counts | null;
    esign: Counts | null;
    email: Counts | null;
    slack: boolean | null;
    teams: boolean | null;
  }>;

  const activity = (c: Counts | null | undefined) => ({ last_event_at: iso(c?.last_at ?? null), events_7d: Number(c?.total ?? 0), failures_7d: Number(c?.failed ?? 0) });

  const payMissing = [
    ...(!config.RAZORPAY_KEY_ID || !config.RAZORPAY_KEY_SECRET ? ["Razorpay API keys"] : []),
    ...(!config.RAZORPAY_WEBHOOK_SECRET ? ["Razorpay webhook secret (payment status updates)"] : []),
  ];
  const payKeys = Boolean(config.RAZORPAY_KEY_ID && config.RAZORPAY_KEY_SECRET);

  const docuseal = Boolean(config.DOCUSEAL_API_KEY);
  const esignMissing = docuseal ? (config.DOCUSEAL_WEBHOOK_SECRET ? [] : ["DocuSeal webhook secret (signature status updates)"]) : ["DocuSeal API key"];
  const esignSandbox = !docuseal && Boolean(config.ESIGN_MOCK_WEBHOOK_SECRET) && config.NODE_ENV !== "production";

  const emailProvider = config.RESEND_API_KEY ? "resend" : config.SMTP_HOST ? "smtp" : null;
  const emailMissing = emailProvider
    ? emailProvider === "resend" && !config.RESEND_WEBHOOK_SECRET
      ? ["Resend webhook secret (delivery, bounce and open tracking)"]
      : []
    : ["An email provider (Resend or SMTP); mail is only logged"];

  return [
    {
      key: "payments",
      provider: payKeys ? "razorpay" : null,
      ...activity(row?.payments),
      ...(payMissing.length || !payKeys
        ? { status: !payKeys ? "not_configured" : "partial", missing: payMissing }
        : webhookProven("connected", row?.payments?.last_at, "Razorpay")),
    },
    {
      key: "esign",
      provider: docuseal ? "docuseal" : esignSandbox ? "mock" : null,
      ...activity(row?.esign),
      ...(docuseal && !esignMissing.length
        ? webhookProven("connected", row?.esign?.last_at, "DocuSeal")
        : { status: docuseal ? "partial" : esignSandbox ? "sandbox" : "not_configured", missing: esignMissing }),
    },
    {
      key: "email",
      provider: emailProvider,
      status: !emailProvider ? "not_configured" : emailMissing.length ? "partial" : "connected",
      missing: emailMissing,
      ...activity(row?.email),
    },
    { key: "slack", provider: row?.slack ? "slack" : null, status: row?.slack ? "connected" : "not_configured", missing: row?.slack ? [] : ["Slack incoming webhook"], last_event_at: null, events_7d: 0, failures_7d: 0 },
    { key: "teams", provider: row?.teams ? "teams" : null, status: row?.teams ? "connected" : "not_configured", missing: row?.teams ? [] : ["Teams incoming webhook"], last_event_at: null, events_7d: 0, failures_7d: 0 },
  ];
}

/** GET /cops/integrations/status — admin:read or admin:admin. External CRMs stay on /crm/connections. */
export async function copsIntegrationsStatusRoutes(app: FastifyInstance, opts: { db: Db }) {
  const { db } = opts;
  const gate = requireAnyCopsPermission(["admin:read", "admin:admin"], (ws, user) => getMemberPermissions(db, ws, user));
  app.get("/cops/integrations/status", { preHandler: gate }, async (request) => ({
    data: await loadIntegrationsStatus(db, app.config, request.workspaceId!),
  }));
}
