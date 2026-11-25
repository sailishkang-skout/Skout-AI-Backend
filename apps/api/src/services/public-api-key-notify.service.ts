import { and, eq } from "drizzle-orm";
import { schema, type Db } from "@skout/db";
import { createLogger } from "@skout/observability";
import { ctaButton, escapeHtml, renderTransactionalLayout, type MailOptions } from "./mail.service.js";

const log = createLogger("public-api-key-notify");
const { workspaceMembers, users, workspaces } = schema;

export interface NewLiveKeyNotice {
  workspaceId: string;
  keyName: string;
  maskedKey: string;
  scopes: string[];
  expiresAt: string;
  createdByEmail: string | null;
  /** "created" for a new key, "rotated" for a replacement issued by rotation. */
  reason: "created" | "rotated";
  appUrl: string | undefined;
}

/** Every Owner's email address in the workspace. */
export async function workspaceOwnerEmails(db: Db, workspaceId: string): Promise<string[]> {
  const rows = await db
    .select({ email: users.email })
    .from(workspaceMembers)
    .innerJoin(users, eq(users.id, workspaceMembers.userId))
    .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.role, "owner")));
  return [...new Set(rows.map((r) => r.email.trim().toLowerCase()).filter(Boolean))];
}

export function buildNewLiveKeyEmail(to: string, workspaceName: string, n: NewLiveKeyNotice): MailOptions {
  const verb = n.reason === "rotated" ? "rotated, issuing a new live key" : "created";
  const title = `A live API key was ${n.reason === "rotated" ? "rotated" : "created"} in ${workspaceName}`;
  const who = n.createdByEmail ?? "a workspace admin";
  const expires = new Date(n.expiresAt).toUTCString().replace(/ GMT$/, " UTC");
  const link = n.appUrl ? `${n.appUrl.replace(/\/$/, "")}/settings/developers` : null;
  const bodyHtml = `
    <p style="margin:0 0 16px;">${escapeHtml(who)} ${escapeHtml(verb)} in <strong>${escapeHtml(workspaceName)}</strong>.</p>
    <p style="margin:0 0 4px;">Key: <strong>${escapeHtml(n.keyName)}</strong> (<code>${escapeHtml(n.maskedKey)}</code>)</p>
    <p style="margin:0 0 4px;">Scopes: ${escapeHtml(n.scopes.join(", "))}</p>
    <p style="margin:0 0 16px;">Expires: ${escapeHtml(expires)}</p>
    <p style="margin:0 0 16px;">Live keys spend the workspace's Data Credits. If you don't recognise this, revoke the key now.</p>
    ${link ? `<p style="margin:0 0 8px;">${ctaButton(link, "Review API keys")}</p>` : ""}
  `;
  return {
    to,
    subject: title,
    text: [
      `${who} ${verb} in ${workspaceName}.`,
      "",
      `Key: ${n.keyName} (${n.maskedKey})`,
      `Scopes: ${n.scopes.join(", ")}`,
      `Expires: ${expires}`,
      "",
      "Live keys spend the workspace's Data Credits. If you don't recognise this, revoke the key now.",
      ...(link ? ["", `Review API keys: ${link}`] : []),
    ].join("\n"),
    html: renderTransactionalLayout({
      preheader: title,
      title,
      bodyHtml,
      footerNote: "You're getting this because you own this Skout AI workspace. Every owner is told about every new live API key.",
    }),
  };
}

/**
 * D7 / KEY-2: every Owner is emailed about every new live key. Sending never fails the key change
 * (the key exists either way); a failure is logged.
 */
export async function notifyOwnersOfNewLiveKey(db: Db, send: (m: MailOptions) => Promise<unknown>, n: NewLiveKeyNotice): Promise<number> {
  try {
    const [ws] = await db.select({ name: workspaces.name }).from(workspaces).where(eq(workspaces.id, n.workspaceId)).limit(1);
    const owners = await workspaceOwnerEmails(db, n.workspaceId);
    for (const to of owners) await send(buildNewLiveKeyEmail(to, ws?.name ?? "your workspace", n));
    return owners.length;
  } catch (err) {
    log.error("could not email owners about a new live API key", err, { workspaceId: n.workspaceId });
    return 0;
  }
}
