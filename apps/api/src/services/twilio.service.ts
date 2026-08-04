import type { Env } from "../config/env.js";
import { createLogger } from "@skout/observability";

const log = createLogger("twilio.service");

export function isTwilioConfigured(config: Env): boolean {
  return Boolean(config.TWILIO_ACCOUNT_SID && config.TWILIO_AUTH_TOKEN && config.TWILIO_PHONE_NUMBER);
}

export interface BridgeCallParams {
  /** The SDR's own phone number — dialed first (E.164, e.g. +14155551234). */
  agentPhone: string;
  /** The prospect's number — dialed once the agent answers. */
  prospectPhone: string;
  /** Query params appended to the status-callback webhook so it can attribute the call on completion. */
  callbackParams: Record<string, string>;
}

export interface BridgeCallResult {
  callSid: string;
  status: string;
}

/**
 * R20.2 — click-to-call bridge. Calls the SDR's own phone first; once they pick up, Twilio
 * fetches TwiML from our `/calls/twiml/bridge` endpoint which <Dial>s the prospect. Uses
 * Twilio's plain REST API over fetch (no SDK dependency) — see docs/tickets for why.
 */
export async function dialBridgeCall(config: Env, params: BridgeCallParams): Promise<BridgeCallResult> {
  if (!isTwilioConfigured(config)) {
    throw new Error("Twilio is not configured (TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN / TWILIO_PHONE_NUMBER)");
  }
  const base = config.TWILIO_WEBHOOK_BASE_URL;
  if (!base) {
    throw new Error("TWILIO_WEBHOOK_BASE_URL (or API_PUBLIC_URL) must be set so Twilio can reach the TwiML/status webhooks");
  }

  const twimlUrl = new URL("/api/v1/calls/twiml/bridge", base);
  twimlUrl.searchParams.set("to", params.prospectPhone);

  const statusUrl = new URL("/api/v1/calls/status", base);
  for (const [key, value] of Object.entries(params.callbackParams)) statusUrl.searchParams.set(key, value);

  const body = new URLSearchParams({
    To: params.agentPhone,
    From: config.TWILIO_PHONE_NUMBER!,
    Url: twimlUrl.toString(),
    StatusCallback: statusUrl.toString(),
    StatusCallbackEvent: "completed",
    StatusCallbackMethod: "POST",
  });

  const auth = Buffer.from(`${config.TWILIO_ACCOUNT_SID}:${config.TWILIO_AUTH_TOKEN}`).toString("base64");
  const res = await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${config.TWILIO_ACCOUNT_SID}/Calls.json`,
    {
      method: "POST",
      headers: {
        Authorization: `Basic ${auth}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: body.toString(),
    }
  );

  const json = (await res.json().catch(() => ({}))) as { sid?: string; status?: string; message?: string };
  if (!res.ok) {
    log.warn("Twilio call creation failed", { status: res.status, body: json });
    throw new Error(json.message ?? `Twilio API returned ${res.status}`);
  }
  return { callSid: json.sid ?? "", status: json.status ?? "queued" };
}

/** TwiML for the bridge leg — Twilio calls this once the agent answers. */
export function buildBridgeTwiml(prospectPhone: string, callerId: string): string {
  const escaped = prospectPhone.replace(/[^0-9+]/g, "");
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Dial callerId="${callerId}">${escaped}</Dial></Response>`;
}
