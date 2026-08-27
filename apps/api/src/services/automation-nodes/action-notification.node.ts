import { createNotification } from "../notifications.service.js";
import type { NodeHandler } from "./types.js";

/** Config: { title: string; body?: string; type: string } */
export const notificationActionNodeHandler: NodeHandler = async (ctx) => {
  const { title, body, type } = ctx.node.config as { title: string; body?: string; type: string };

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
