import { eq, sql } from "drizzle-orm";
import { schema, type Db } from "@skout/db";
import { createLogger } from "@skout/observability";
import { ctaButton, escapeHtml, renderTransactionalLayout, type MailOptions } from "./mail.service.js";
import type { WebhookEventType } from "./webhook.service.js";
import { workspaceOwnerEmails } from "./public-api-key-notify.service.js";

const log = createLogger("low-balance-alert");
const { workspaceApiSettings, workspaces } = schema;

/**
 * Low-balance alert (PAPI-036, public API PRD CRED-8): when the Data Credit balance is below the
 * workspace's threshold (the owner's setting, else PUBLIC_API_LOW_BALANCE_THRESHOLD), every Owner is
 * emailed and a `credits.low` webhook is sent, at most once per 24 hours. The 24-hour slot is claimed
 * with a conditional update before anything is sent, so parallel charges send one alert.
 */
export const LOW_BALANCE_ALERT_INTERVAL_MS = 24 * 60 * 60_000;

export interface LowBalanceDeps {
  sendMail(m: MailOptions): Promise<unknown>;
  dispatchWebhook(eventType: WebhookEventType, workspaceId: string, payload: Record<string, unknown>): Promise<void>;
  defaultThreshold: number;
  appUrl: string | undefined;
}

export interface LowBalanceResult {
  alerted: boolean;
  threshold: number;
  recipients: number;
}

export async function checkLowBalance(db: Db, deps: LowBalanceDeps, workspaceId: string, balance: number, now = new Date()): Promise<LowBalanceResult> {
  const [s] = await db
    .select({ threshold: workspaceApiSettings.lowBalanceThreshold })
    .from(workspaceApiSettings)
    .where(eq(workspaceApiSettings.workspaceId, workspaceId))
    .limit(1);
  const threshold = s?.threshold ?? deps.defaultThreshold;
  if (balance >= threshold) return { alerted: false, threshold, recipients: 0 };

  // Claim the 24-hour slot (creating the settings row if the workspace has none yet).
  const cutoff = new Date(now.getTime() - LOW_BALANCE_ALERT_INTERVAL_MS).toISOString();
  const claimed = (await db.execute(sql`
    insert into workspace_api_settings (workspace_id, low_balance_alerted_at)
    values (${workspaceId}, ${now.toISOString()}::timestamptz)
    on conflict (workspace_id) do update set low_balance_alerted_at = excluded.low_balance_alerted_at
      where workspace_api_settings.low_balance_alerted_at is null
         or workspace_api_settings.low_balance_alerted_at <= ${cutoff}::timestamptz
    returning workspace_id
  `)) as unknown as unknown[];
  if (claimed.length === 0) return { alerted: false, threshold, recipients: 0 };

  const [ws] = await db.select({ name: workspaces.name }).from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1);
  const owners = await workspaceOwnerEmails(db, workspaceId);
  for (const to of owners) {
    await deps.sendMail(buildLowBalanceEmail({ to, workspaceName: ws?.name ?? "your workspace", balance, threshold, appUrl: deps.appUrl }));
  }
  await deps.dispatchWebhook("credits.low", workspaceId, { balance, threshold, at: now.toISOString() });
  return { alerted: true, threshold, recipients: owners.length };
}

export function buildLowBalanceEmail(o: { to: string; workspaceName: string; balance: number; threshold: number; appUrl: string | undefined }): MailOptions {
  const title = `Data Credits are running low in ${o.workspaceName}`;
  const link = o.appUrl ? `${o.appUrl.replace(/\/$/, "")}/settings/developers` : null;
  const bodyHtml = `
    <p style="margin:0 0 16px;"><strong>${escapeHtml(o.workspaceName)}</strong> has <strong>${o.balance}</strong> Data Credits left, below your alert level of ${o.threshold}.</p>
    <p style="margin:0 0 16px;">API calls that need credits will be refused once the balance runs out. Buy a credit pack to keep them working.</p>
    ${link ? `<p style="margin:0 0 8px;">${ctaButton(link, "Buy credits")}</p>` : ""}
  `;
  return {
    to: o.to,
    subject: title,
    text: [
      `${o.workspaceName} has ${o.balance} Data Credits left, below your alert level of ${o.threshold}.`,
      "",
      "API calls that need credits will be refused once the balance runs out. Buy a credit pack to keep them working.",
      ...(link ? ["", `Buy credits: ${link}`] : []),
    ].join("\n"),
    html: renderTransactionalLayout({
      preheader: title,
      title,
      bodyHtml,
      footerNote: "You're getting this because you own this Skout AI workspace. We send this at most once a day.",
    }),
  };
}

// --- Process-wide notifier (set by the app at start-up) -------------------------------

type Notifier = (workspaceId: string, balance: number) => Promise<void>;
let notifier: Notifier | null = null;

export function setLowBalanceNotifier(fn: Notifier | null): void {
  notifier = fn;
}
export function clearLowBalanceNotifier(fn: Notifier): void {
  if (notifier === fn) notifier = null;
}

/** Called after a charge commits. Never throws: the charge has already happened. */
export async function notifyBalanceAfterCharge(workspaceId: string, balance: number): Promise<void> {
  if (!notifier) return;
  try {
    await notifier(workspaceId, balance);
  } catch (err) {
    log.warn("low-balance check failed", { workspaceId, err: (err as Error).message });
  }
}
