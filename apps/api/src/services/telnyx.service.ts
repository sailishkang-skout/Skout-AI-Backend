import type { Env } from "../config/env.js";
import { createLogger } from "@skout/observability";
import type { BridgeCallParams, BridgeCallResult, SendSmsParams, SendSmsResult } from "./telecom.types.js";

const log = createLogger("telnyx.service");

export function isTelnyxConfigured(config: Env): boolean {
  return Boolean(
    config.TELNYX_API_KEY &&
      config.TELNYX_PHONE_NUMBER &&
      config.TELNYX_CONNECTION_ID
  );
}

export function isTelnyxSmsConfigured(config: Env): boolean {
  return Boolean(config.TELNYX_API_KEY && config.TELNYX_PHONE_NUMBER);
}

function webhookBaseUrl(config: Env): string {
  const base = config.TELECOM_WEBHOOK_BASE_URL ?? config.TWILIO_WEBHOOK_BASE_URL;
  if (!base) {
    throw new Error(
      "TELECOM_WEBHOOK_BASE_URL (or API_PUBLIC_URL) must be set so Telnyx can reach TeXML/status webhooks"
    );
  }
  return base;
}

function telnyxErrorMessage(json: unknown, fallback: string): string {
  if (json && typeof json === "object") {
    const errors = (json as { errors?: Array<{ detail?: string; title?: string }> }).errors;
    const first = errors?.[0];
    if (first?.detail) return first.detail;
    if (first?.title) return first.title;
    const message = (json as { message?: string }).message;
    if (message) return message;
  }
  return fallback;
}

/**
 * R20.2 — click-to-call bridge via Telnyx TeXML (Twilio-compatible XML verbs).
 * Calls the SDR first; once they answer, Telnyx fetches TeXML from `/calls/twiml/bridge`.
 */
export async function dialBridgeCall(config: Env, params: BridgeCallParams): Promise<BridgeCallResult> {
  const fromNumber = params.fromNumber ?? config.TELNYX_PHONE_NUMBER;
  if (!config.TELNYX_API_KEY || !config.TELNYX_CONNECTION_ID || !fromNumber) {
    throw new Error(
      "Telnyx is not configured (TELNYX_API_KEY / TELNYX_CONNECTION_ID / caller ID)"
    );
  }

  const base = webhookBaseUrl(config);
  const texmlUrl = new URL("/api/v1/calls/twiml/bridge", base);
  texmlUrl.searchParams.set("to", params.prospectPhone);
  for (const [key, value] of Object.entries(params.callbackParams)) {
    texmlUrl.searchParams.set(key, value);
  }

  const statusUrl = new URL("/api/v1/calls/status", base);
  for (const [key, value] of Object.entries(params.callbackParams)) {
    statusUrl.searchParams.set(key, value);
  }

  const body = new URLSearchParams({
    To: params.agentPhone,
    From: fromNumber,
    Url: texmlUrl.toString(),
    StatusCallback: statusUrl.toString(),
    StatusCallbackEvent: "completed",
    StatusCallbackMethod: "POST",
  });

  const res = await fetch(`https://api.telnyx.com/v2/texml/calls/${config.TELNYX_CONNECTION_ID}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.TELNYX_API_KEY}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: body.toString(),
  });

  const json = (await res.json().catch(() => ({}))) as {
    data?: { call_sid?: string; sid?: string; status?: string };
    call_sid?: string;
    sid?: string;
    status?: string;
  };

  if (!res.ok) {
    log.warn("Telnyx call creation failed", { status: res.status, body: json });
    throw new Error(telnyxErrorMessage(json, `Telnyx API returned ${res.status}`));
  }

  const payload = json.data ?? json;
  return {
    callSid: payload.call_sid ?? payload.sid ?? "",
    status: payload.status ?? "queued",
  };
}

/** SMS delivery for reminders and notification-preferences "sms" channel. */
export async function sendSms(config: Env, params: SendSmsParams): Promise<SendSmsResult> {
  const fromNumber = params.fromNumber ?? config.TELNYX_PHONE_NUMBER;
  if (!config.TELNYX_API_KEY || !fromNumber) {
    throw new Error("Telnyx is not configured (TELNYX_API_KEY / caller ID)");
  }

  const res = await fetch("https://api.telnyx.com/v2/messages", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.TELNYX_API_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      from: fromNumber,
      to: params.to,
      text: params.body,
    }),
  });

  const json = (await res.json().catch(() => ({}))) as {
    data?: { id?: string; status?: string };
  };

  if (!res.ok) {
    log.warn("Telnyx SMS creation failed", { status: res.status, body: json });
    throw new Error(telnyxErrorMessage(json, `Telnyx API returned ${res.status}`));
  }

  return {
    messageSid: json.data?.id ?? "",
    status: json.data?.status ?? "queued",
  };
}
