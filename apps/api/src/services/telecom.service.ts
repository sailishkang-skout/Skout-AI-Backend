import type { Env } from "../config/env.js";
import { buildBridgeTwiml, dialBridgeCall as dialTwilio, isTwilioConfigured, sendSms as sendTwilioSms } from "./twilio.service.js";
import { dialBridgeCall as dialTelnyx, isTelnyxConfigured, isTelnyxSmsConfigured, sendSms as sendTelnyxSms } from "./telnyx.service.js";
import type { BridgeCallParams, BridgeCallResult, SendSmsParams, SendSmsResult } from "./telecom.types.js";

export type TelecomProvider = "twilio" | "telnyx";

/** When true and Twilio creds exist, use Twilio; otherwise fall back to Telnyx. */
export function activeTelecomProvider(config: Env): TelecomProvider | null {
  if (config.TWILIO_ENABLED && isTwilioConfigured(config)) return "twilio";
  if (isTelnyxConfigured(config) || isTelnyxSmsConfigured(config)) return "telnyx";
  return null;
}

export function isCallingConfigured(config: Env): boolean {
  if (config.TWILIO_ENABLED && isTwilioConfigured(config)) return true;
  return isTelnyxConfigured(config);
}

export function isSmsConfigured(config: Env): boolean {
  if (config.TWILIO_ENABLED && isTwilioConfigured(config)) return true;
  return isTelnyxSmsConfigured(config);
}

export function telecomProviderLabel(config: Env): string {
  const provider = activeTelecomProvider(config);
  if (provider === "twilio") return "Twilio";
  if (provider === "telnyx") return "Telnyx";
  return "none";
}

export function telecomWebhookBaseUrl(config: Env): string | undefined {
  return config.TELECOM_WEBHOOK_BASE_URL ?? config.TWILIO_WEBHOOK_BASE_URL;
}

export function callerIdNumber(config: Env): string {
  if (config.TWILIO_ENABLED && isTwilioConfigured(config)) return config.TWILIO_PHONE_NUMBER!;
  if (isTelnyxConfigured(config) || isTelnyxSmsConfigured(config)) return config.TELNYX_PHONE_NUMBER!;
  throw new Error("No telecom provider configured");
}

export async function dialBridgeCall(config: Env, params: BridgeCallParams): Promise<BridgeCallResult> {
  if (config.TWILIO_ENABLED && isTwilioConfigured(config)) return dialTwilio(config, params);
  if (isTelnyxConfigured(config)) return dialTelnyx(config, params);
  throw new Error(
    "Calling is not configured — enable TWILIO_ENABLED with Twilio creds, or set TELNYX_API_KEY/TELNYX_PHONE_NUMBER/TELNYX_CONNECTION_ID"
  );
}

export async function sendSms(config: Env, params: SendSmsParams): Promise<SendSmsResult> {
  if (config.TWILIO_ENABLED && isTwilioConfigured(config)) return sendTwilioSms(config, params);
  if (isTelnyxSmsConfigured(config)) return sendTelnyxSms(config, params);
  throw new Error(
    "SMS is not configured — enable TWILIO_ENABLED with Twilio creds, or set TELNYX_API_KEY/TELNYX_PHONE_NUMBER"
  );
}

/** TeXML/TwiML for the bridge leg once the agent answers. */
export function buildBridgeXml(
  config: Env,
  prospectPhone: string,
  recordingStatusCallbackUrl?: string
): string {
  return buildBridgeTwiml(prospectPhone, callerIdNumber(config), recordingStatusCallbackUrl);
}
