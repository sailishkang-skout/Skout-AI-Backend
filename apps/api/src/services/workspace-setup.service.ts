import { count, eq } from "drizzle-orm";
import type { Db } from "@skout/db";
import { schema } from "@skout/db";
import { getWorkspaceIcp, isIcpConfigured } from "./icp.service.js";

export interface SetupChecklistItem {
  id: "icp" | "list" | "mailbox" | "prospect";
  label: string;
  done: boolean;
  href: string;
}

export interface SetupChecklist {
  items: SetupChecklistItem[];
  complete: boolean;
  /** True once the minimum bar for sending real outbound email is met — see `isReadyForOutboundSend`. */
  readyForOutboundSend: boolean;
}

/**
 * R8.1 — "checklist completion should visibly gate which live actions are enabled." A workspace
 * needs a configured ICP and at least one connected sending mailbox before it can send real
 * outbound email; list/prospect activity are tracked in the checklist but don't block sending
 * (a workspace enrolling by prospectId directly hasn't necessarily built a list first).
 */
export async function isReadyForOutboundSend(db: Db | null, workspaceId: string): Promise<boolean> {
  const icp = await getWorkspaceIcp(db, workspaceId);
  if (!isIcpConfigured(icp)) return false;
  if (!db) return false;

  const [{ mailboxCount }] = await db
    .select({ mailboxCount: count() })
    .from(schema.inboxes)
    .where(eq(schema.inboxes.workspaceId, workspaceId));
  return Number(mailboxCount) > 0;
}

export async function getSetupChecklist(db: Db | null, workspaceId: string): Promise<SetupChecklist> {
  const icp = await getWorkspaceIcp(db, workspaceId);
  const icpDone = isIcpConfigured(icp);

  if (!db) {
    const items: SetupChecklistItem[] = [
      { id: "icp", label: "Configure your ICP", done: icpDone, href: "/onboarding" },
      { id: "list", label: "Create a list", done: false, href: "/lists" },
      { id: "mailbox", label: "Connect a sending mailbox", done: false, href: "/settings/sending" },
      { id: "prospect", label: "Add or activate a prospect", done: false, href: "/prospects/search" },
    ];
    return { items, complete: items.every((i) => i.done), readyForOutboundSend: false };
  }

  const [[{ listCount }], [{ mailboxCount }], [{ prospectCount }]] = await Promise.all([
    db.select({ listCount: count() }).from(schema.lists).where(eq(schema.lists.workspaceId, workspaceId)),
    db.select({ mailboxCount: count() }).from(schema.inboxes).where(eq(schema.inboxes.workspaceId, workspaceId)),
    db
      .select({ prospectCount: count() })
      .from(schema.prospectActivations)
      .where(eq(schema.prospectActivations.workspaceId, workspaceId)),
  ]);

  const items: SetupChecklistItem[] = [
    { id: "icp", label: "Configure your ICP", done: icpDone, href: "/onboarding" },
    { id: "list", label: "Create a list", done: Number(listCount) > 0, href: "/lists" },
    {
      id: "mailbox",
      label: "Connect a sending mailbox",
      done: Number(mailboxCount) > 0,
      href: "/settings/sending",
    },
    {
      id: "prospect",
      label: "Add or activate a prospect",
      done: Number(prospectCount) > 0,
      href: "/prospects/search",
    },
  ];

  return {
    items,
    complete: items.every((i) => i.done),
    readyForOutboundSend: icpDone && Number(mailboxCount) > 0,
  };
}
