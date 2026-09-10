import { createNotification } from "../notifications.service.js";
import type { NodeHandler } from "./types.js";

/**
 * Config: { title: string; body?: string; type?: string }. `type` defaults here rather than in
 * the config panel, because the panel only *displays* "workflow" as a placeholder value — it
 * isn't written into the saved graph unless the user actually edits that field, and `type` is a
 * NOT NULL column with no database-level default, so an untouched field crashed the insert.
 */
export const notificationActionNodeHandler: NodeHandler = async (ctx) => {
  const { title, body, type = "workflow" } = ctx.node.config as { title: string; body?: string; type?: string };

  if (ctx.isSimulation) {
    return { output: { simulated: true, title, body, type } };
  }

  const notification = await createNotification(ctx.db, ctx.config, {
    workspaceId: ctx.workspaceId,
    title,
    body,
    type,
  });
  return { output: { notificationId: notification.id } };
};
