import type { FastifyInstance } from "fastify";
import fp from "fastify-plugin";
import { sendMail } from "../services/mail.service.js";
import { dispatchWebhookEvent } from "../services/webhook.service.js";
import { checkLowBalance, clearLowBalanceNotifier, setLowBalanceNotifier } from "../services/low-balance-alert.service.js";

/** PAPI-036: wires the low-balance alert (email + credits.low webhook) to committed API charges. */
export const creditAlertsPlugin = fp(async (app: FastifyInstance) => {
  if (!app.db) return;
  const db = app.db;
  const notify = async (workspaceId: string, balance: number) => {
    await checkLowBalance(
      db,
      {
        sendMail: (m) => sendMail(app.config, m),
        dispatchWebhook: (eventType, ws, payload) => dispatchWebhookEvent(db, app.config, eventType, ws, payload),
        defaultThreshold: app.config.PUBLIC_API_LOW_BALANCE_THRESHOLD,
        appUrl: app.config.INVITE_BASE_URL ?? app.config.FRONTEND_URL,
      },
      workspaceId,
      balance
    );
  };
  setLowBalanceNotifier(notify);
  app.addHook("onClose", async () => clearLowBalanceNotifier(notify));
});
