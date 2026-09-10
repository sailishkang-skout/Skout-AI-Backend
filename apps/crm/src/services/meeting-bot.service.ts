import type { Env } from "../config/env.js";
import { serviceLog } from "../lib/obs.js";

const log = serviceLog("meeting-bot");

export function isMeetingBotConfigured(config: Env): boolean {
  return Boolean(config.MEETING_BOT_PROVIDER && config.MEETING_BOT_API_KEY);
}

export interface ScheduleBotResult {
  botExternalId: string;
}

/**
 * R16.2 — schedule a bot to join `meetingUrl` and send a webhook (transcript/status) back to
 * `POST /meetings/webhook` once it completes. Recall.ai is the reference implementation (a
 * single REST call, no SDK needed); Fireflies.ai's API shape differs enough that it's stubbed
 * separately rather than guessed at — see docs/tickets for the vendor decision this is blocked on.
 */
export async function scheduleMeetingBot(
  config: Env,
  meetingUrl: string,
  webhookUrl: string
): Promise<ScheduleBotResult> {
  if (!isMeetingBotConfigured(config)) {
    throw new Error("Meeting bot is not configured (MEETING_BOT_PROVIDER / MEETING_BOT_API_KEY)");
  }

  if (config.MEETING_BOT_PROVIDER === "recall") {
    const res = await fetch("https://us-east-1.recall.ai/api/v1/bot/", {
      method: "POST",
      headers: {
        Authorization: `Token ${config.MEETING_BOT_API_KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        meeting_url: meetingUrl,
        webhook_url: webhookUrl,
        transcription_options: { provider: "meeting_captions" },
      }),
    });
    const json = (await res.json().catch(() => ({}))) as { id?: string; message?: string };
    if (!res.ok || !json.id) {
      log.warn("Recall.ai bot schedule failed", { status: res.status, body: json });
      throw new Error(json.message ?? `Recall.ai returned ${res.status}`);
    }
    return { botExternalId: json.id };
  }

  // Fireflies.ai has no equivalent "join an arbitrary meeting URL" REST endpoint at time of
  // writing (it auto-joins calendar-linked meetings instead) — real support needs a calendar
  // integration first, which is out of scope here. Fail loudly instead of silently no-op'ing.
  throw new Error(
    `MEETING_BOT_PROVIDER=${config.MEETING_BOT_PROVIDER} is not yet implemented — only "recall" is wired up`
  );
}
