import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { createDb, postCreditTransaction } from "@skout/db";
import { runCreditReconciliation } from "./credit-reconciliation.worker.js";

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
});
