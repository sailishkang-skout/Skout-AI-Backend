import { createNotification } from "../notifications.service.js";
import type { Db } from "@skout/db";
import type { NodeHandler } from "./types.js";
import { withStepEffect } from "./step-effect.js";

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

  // COPS-10: recorded against the step, so a step re-run after a crash does not notify twice.
  const output = await withStepEffect(ctx, "notification", async (tx) => {
    const notification = await createNotification(tx as unknown as Db, ctx.config, { workspaceId: ctx.workspaceId, title, body, type });
    return { notificationId: notification.id };
  });
  return { output };
};
