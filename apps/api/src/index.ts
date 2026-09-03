import "./instrument.js";
import { initRootLogger, initSentry } from "@skout/observability";
import { loadEnv } from "./config/env.js";
import { ensureClickHouseSchema } from "./lib/clickhouse.js";
import { buildApp } from "./app.js";
import { startCrmExportWorker } from "./workers/crm-export.worker.js";
import { startListScoreWorker } from "./workers/list-score.worker.js";
import { startWorkspaceRescoreWorker } from "./workers/workspace-rescore.worker.js";
import { startSequenceEnrollmentWorker } from "./workers/sequence-enrollment.worker.js";
import { startAutomationRunWorker } from "./workers/automation-run.worker.js";
import { startDexterOrchestratorWorker } from "./workers/dexter-orchestrator.worker.js";
import { startImapPollWorker } from "./workers/imap-poll.worker.js";
import { startReplyTagWorker } from "./workers/reply-tag.worker.js";
import { startBlacklistMonitorWorker } from "./workers/blacklist-monitor.worker.js";
import { startWarmupRampWorker } from "./workers/warmup-ramp.worker.js";
import { startWebhookDeliveryWorker } from "./workers/webhook-delivery.worker.js";
import { startSmartListRefreshWorker } from "./workers/smart-list-refresh.worker.js";
import { startSmartListRefreshSweepWorker } from "./workers/smart-list-refresh-sweep.worker.js";
import { startReminderSweepWorker } from "./workers/reminder-sweep.worker.js";
import { startSignalAlertSweepWorker } from "./workers/signal-alert-sweep.worker.js";
import { startAlertDigestSweepWorker } from "./workers/alert-digest-sweep.worker.js";
import { startRiskDecaySweepWorker } from "./workers/risk-decay-sweep.worker.js";
import { startWorkbookRunWorker } from "./workers/workbook-run.worker.js";
import { startReportDeliverySweepWorker } from "./workers/report-delivery-sweep.worker.js";
import { startIdentityMergeDiscoveryWorker } from "./workers/identity-merge-discovery.worker.js";
import { startDexterEventWorker } from "./workers/dexter-event.worker.js";
import { startRetentionSweepWorker } from "./workers/retention-sweep.worker.js";

async function main() {
  const config = loadEnv();

  void ensureClickHouseSchema(config);

  initRootLogger({
    service: config.SERVICE_NAME,
    level: config.LOG_LEVEL,
    environment: config.NODE_ENV,
    version: config.SERVICE_VERSION,
  });

  initSentry({
    dsn: config.SENTRY_DSN,
    service: config.SERVICE_NAME,
    environment: config.NODE_ENV,
    release: config.SERVICE_VERSION,
    tracesSampleRate: config.SENTRY_TRACES_SAMPLE_RATE,
  });

  const stopCrmWorker = await startCrmExportWorker(config);
  const stopListScoreWorker = await startListScoreWorker(config);
  const stopWorkspaceRescoreWorker = await startWorkspaceRescoreWorker(config);
  const stopSeqWorker = await startSequenceEnrollmentWorker(config);
  const stopAutomationRunWorker = await startAutomationRunWorker(config);
  const stopDexterOrchestratorWorker = await startDexterOrchestratorWorker(config);
  const stopImapPollWorker = await startImapPollWorker(config);
  const stopReplyTagWorker = await startReplyTagWorker(config);
  const stopBlacklistMonitorWorker = await startBlacklistMonitorWorker(config);
  const stopWarmupRampWorker = await startWarmupRampWorker(config);
  const stopWebhookDeliveryWorker = await startWebhookDeliveryWorker(config);
  const stopSmartListRefreshWorker = await startSmartListRefreshWorker(config);
  const stopSmartListRefreshSweepWorker = await startSmartListRefreshSweepWorker(config);
  const stopReminderSweepWorker = await startReminderSweepWorker(config);
  const stopSignalAlertSweepWorker = await startSignalAlertSweepWorker(config);
  const stopAlertDigestSweepWorker = await startAlertDigestSweepWorker(config);
  const stopRiskDecaySweepWorker = await startRiskDecaySweepWorker(config);
  const stopWorkbookRunWorker = await startWorkbookRunWorker(config);
  const stopReportDeliverySweepWorker = await startReportDeliverySweepWorker(config);
  const stopIdentityMergeDiscoveryWorker = await startIdentityMergeDiscoveryWorker(config);
  const stopDexterEventWorker = await startDexterEventWorker(config);
  const stopRetentionSweepWorker = await startRetentionSweepWorker(config);

  const app = await buildApp(config);

  if (config.RBAC_ENFORCEMENT_ENABLED && app.db) {
    const { assertRbacBackfillReady } = await import("@skout/auth");
    const gate = await assertRbacBackfillReady(app.db);
    if (!gate.ready) {
      app.log.fatal(
        "RBAC_ENFORCEMENT_ENABLED=true but workspace_member_roles is empty — run pnpm --filter @skout/db backfill-rbac before enabling fail-closed RBAC"
      );
      process.exit(1);
    }
    app.log.info("RBAC fail-closed enforcement enabled (backfill verified)");
  }

  const shutdown = async () => {
    await stopReportDeliverySweepWorker();
    await stopWorkbookRunWorker();
    await stopIdentityMergeDiscoveryWorker();
    await stopDexterEventWorker();
    await stopRetentionSweepWorker();
    await stopRiskDecaySweepWorker();
    await stopAlertDigestSweepWorker();
    await stopSignalAlertSweepWorker();
    await stopReminderSweepWorker();
    await stopSmartListRefreshSweepWorker();
    await stopSmartListRefreshWorker();
    await stopWebhookDeliveryWorker();
    await stopWarmupRampWorker();
    await stopBlacklistMonitorWorker();
    await stopReplyTagWorker();
    await stopImapPollWorker();
    await stopSeqWorker();
    await stopAutomationRunWorker();
    await stopDexterOrchestratorWorker();
    await stopWorkspaceRescoreWorker();
    await stopListScoreWorker();
    await stopCrmWorker();
    await app.close();
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());

  try {
    await app.listen({ port: config.PORT, host: config.HOST });
    app.log.info(
      { host: config.HOST, port: config.PORT, service: config.SERVICE_NAME },
      "Skout API listening"
    );
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === "EADDRINUSE") {
      app.log.error(
        { port: config.PORT },
        `Port ${config.PORT} is already in use — stop the other process and restart the API`
      );
    } else {
      app.log.error({ err }, "API failed to start");
    }
    process.exit(1);
  }
}

main();
