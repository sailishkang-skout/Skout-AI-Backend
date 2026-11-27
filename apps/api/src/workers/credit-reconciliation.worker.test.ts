import { describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { createDb, postCreditTransaction } from "@skout/db";
import { runCreditReconciliation } from "./credit-reconciliation.worker.js";

// Captures the worker's error logs: each mismatch logged at error level is an alert.
const alerts = vi.hoisted(() => ({ errors: [] as { msg: string; fields: Record<string, unknown> }[] }));
vi.mock("@skout/observability", async (importOriginal) => {
  const real = await importOriginal<typeof import("@skout/observability")>();
  return {
    ...real,
    createLogger: (module: string) => {
      const base = real.createLogger(module);
      return Object.assign(Object.create(base), {
        error: (msg: string, fields: Record<string, unknown>) => alerts.errors.push({ msg, fields }),
      });
    },
  };
});

const postgres = createRequire(new URL("../../../../packages/db/package.json", import.meta.url))("postgres") as (url: string, options?: object) => any;
const url = process.env.COPS_TEST_DATABASE_URL;
const maybe = url ? describe : describe.skip;

maybe("COPS-04 daily credit reconciliation (Postgres)", () => {
  it("records a run that flags a corrupted wallet and does not change it", async () => {
    const sql = postgres(url as string, { max: 1, onnotice: () => {} });
    const { db, sql: dbSql } = createDb(url as string);
    const [ws] = await sql`insert into workspaces (name, slug) values ('Recon', ${"recon-" + randomUUID()}) returning id`;
    try {
      await postCreditTransaction(db, { workspaceId: ws.id, amount: 40, kind: "grant", action: "provision" });
      await sql`update credit_balances set balance = 41 where workspace_id = ${ws.id}`;
      const report = await runCreditReconciliation(db, "test");
      expect(report.mismatches.filter((m) => m.workspace_id === ws.id)).toEqual([
        expect.objectContaining({ balance: 41, ledger_sum: 40, problem: "balance_differs_from_ledger" }),
      ]);
      const [run] = await sql`select triggered_by from credit_reconciliation_runs where id = ${report.runId}`;
      expect(run.triggered_by).toBe("test");
      const [after] = await sql`select balance from credit_balances where workspace_id = ${ws.id}`;
      expect(after.balance).toBe(41);
    } finally {
      await sql`delete from workspaces where id = ${ws.id}`;
      await sql.end();
      await dbSql.end();
    }
  });

  it("raises an alert for a deliberately corrupted public API fixture (PAPI-035)", async () => {
    const sql = postgres(url as string, { max: 1, onnotice: () => {} });
    const { db, sql: dbSql } = createDb(url as string);
    const [ws] = await sql`insert into workspaces (name, slug) values ('Recon API', ${"recon-api-" + randomUUID()}) returning id`;
    try {
      await postCreditTransaction(db, { workspaceId: ws.id, amount: 40, kind: "purchase", action: "test" });
      const [key] = await sql`insert into api_keys (workspace_id, name, type, prefix, key_hmac, expires_at)
        values (${ws.id}, 'k', 'live', ${randomUUID().replace(/-/g, "").slice(0, 12)}, 'h', now() + interval '30 days') returning id`;
      // Corruption: a hold marked committed whose charge never reached the ledger.
      await sql`insert into credit_holds (workspace_id, api_key_id, request_id, amount, status, expires_at, settled_at)
        values (${ws.id}, ${key.id}, 'req_lost', 6, 'committed', now() + interval '15 minutes', now())`;
      alerts.errors = [];
      const report = await runCreditReconciliation(db, "test");
      expect(report.apiMismatches.filter((m) => m.workspace_id === ws.id)).toEqual([
        expect.objectContaining({ problem: "hold_committed_without_charge", request_id: "req_lost", expected: 6 }),
      ]);
      const alert = alerts.errors.find((e) => e.msg === "public API credit mismatch" && e.fields.workspace_id === ws.id);
      expect(alert?.fields).toMatchObject({ problem: "hold_committed_without_charge", runId: report.runId });
      const [run] = await sql`select mismatch_count from credit_reconciliation_runs where id = ${report.runId}`;
      expect(run.mismatch_count).toBeGreaterThanOrEqual(1);
    } finally {
      await sql`delete from workspaces where id = ${ws.id}`;
      await sql.end();
      await dbSql.end();
    }
  });
});
