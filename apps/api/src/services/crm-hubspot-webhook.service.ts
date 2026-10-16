import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { schema, type Db } from "@skout/db";
import { fetchHubSpotPortalId, verifyHubSpotWebhookSignature, verifyHubSpotWebhookSignatureV3 } from "./hubspot.client.js";

/**
 * COPS-09 HubSpot webhook handling (audit section 3.3).
 *
 * Before: the workspace came from `?workspaceId=` on the URL, which the v1 signature does not
 * cover, so one captured signed request could start a sync for any workspace; and a redelivered
 * event ran again. Now:
 *  - the workspace is the one whose HubSpot connection has the event's `portalId`;
 *  - the v3 signature (method + full URL + body + timestamp, five minutes) is checked when HubSpot
 *    sends it, the v1 signature otherwise;
 *  - each event id is processed once (`cops_processed_events`, consumer "hubspot-webhook").
 */
const { crmConnections, copsProcessedEvents } = schema;
const CONSUMER = "hubspot-webhook";

interface HubSpotWebhookEvent {
  eventId?: number | string;
  portalId?: number | string;
  subscriptionType?: string;
  objectId?: number | string;
  occurredAt?: number;
}

/** HubSpot event ids are numbers; the processed-events table keys on a UUID. */
export function hubspotEventKey(portalId: string, eventId: string): string {
  const h = createHash("sha256").update(`hubspot:${portalId}:${eventId}`).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

export function verifyHubSpotWebhook(
  clientSecret: string,
  input: { method: string; uri: string | null; rawBody: string; headers: Record<string, string | string[] | undefined>; nowMs?: number }
): boolean {
  const h = (name: string) => {
    const v = input.headers[name];
    return Array.isArray(v) ? v[0] : v;
  };
  const v3 = h("x-hubspot-signature-v3");
  if (v3) {
    // v3 needs the public URL HubSpot called; without API_PUBLIC_URL it cannot be rebuilt.
    if (!input.uri) return false;
    return verifyHubSpotWebhookSignatureV3(clientSecret, { method: input.method, uri: input.uri, rawBody: input.rawBody, timestamp: h("x-hubspot-request-timestamp"), signature: v3, nowMs: input.nowMs });
  }
  return verifyHubSpotWebhookSignature(clientSecret, input.rawBody, h("x-hubspot-signature"));
}

export interface HubSpotWebhookOutcome {
  /** Workspaces with at least one event not seen before; each gets one bounded sync. */
  workspaces: string[];
  events: number;
  duplicates: number;
  /** Events for a HubSpot account no workspace is connected to. */
  unmatched: number;
}

/** Maps events to workspaces by portal id and records each event once. Does not run the sync. */
export async function acceptHubSpotWebhookEvents(db: Db, rawBody: string): Promise<HubSpotWebhookOutcome> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    parsed = null;
  }
  const events = (Array.isArray(parsed) ? parsed : []) as HubSpotWebhookEvent[];
  const outcome: HubSpotWebhookOutcome = { workspaces: [], events: events.length, duplicates: 0, unmatched: 0 };
  const byPortal = new Map<string, string[]>();
  for (const e of events) {
    if (e.portalId == null || e.eventId == null) {
      outcome.unmatched += 1;
      continue;
    }
    const portal = String(e.portalId);
    if (!byPortal.has(portal)) {
      const rows = await db
        .select({ workspaceId: crmConnections.workspaceId })
        .from(crmConnections)
        .where(and(eq(crmConnections.provider, "hubspot"), eq(crmConnections.externalAccountId, portal)));
      byPortal.set(portal, rows.map((r) => r.workspaceId));
    }
    const workspaces = byPortal.get(portal)!;
    if (workspaces.length === 0) {
      outcome.unmatched += 1;
      continue;
    }
    const [fresh] = await db
      .insert(copsProcessedEvents)
      .values({ consumer: CONSUMER, eventId: hubspotEventKey(portal, String(e.eventId)) })
      .onConflictDoNothing()
      .returning({ eventId: copsProcessedEvents.eventId });
    if (!fresh) {
      outcome.duplicates += 1;
      continue;
    }
    for (const w of workspaces) if (!outcome.workspaces.includes(w)) outcome.workspaces.push(w);
  }
  return outcome;
}

/**
 * Connections made before COPS-09 stored an HMAC of the token instead of the portal id. On the
 * next sync, look the real id up and store it, so webhooks reach the workspace. Best effort.
 */
export async function ensureHubSpotPortalId(db: Db, workspaceId: string, accessToken: string, fetchImpl: typeof fetch = fetch): Promise<string | null> {
  const [row] = await db
    .select({ id: crmConnections.id, externalAccountId: crmConnections.externalAccountId })
    .from(crmConnections)
    .where(and(eq(crmConnections.workspaceId, workspaceId), eq(crmConnections.provider, "hubspot")))
    .limit(1);
  if (!row) return null;
  if (row.externalAccountId && /^\d+$/.test(row.externalAccountId)) return row.externalAccountId;
  const portalId = await fetchHubSpotPortalId(accessToken, fetchImpl);
  await db.update(crmConnections).set({ externalAccountId: portalId, updatedAt: new Date() }).where(eq(crmConnections.id, row.id));
  return portalId;
}
