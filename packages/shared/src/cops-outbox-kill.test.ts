import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { relayCopsOutboxRow } from "./cops-relay.js";

// postgres is a dependency of packages/db; resolve it from there.
const dbRequire = createRequire(new URL("../../db/package.json", import.meta.url));
const POSTGRES_PATH = dbRequire.resolve("postgres");

/**
 * Real-process kill test for the COPS outbox (Postgres, not in-memory).
 * Runs only when COPS_TEST_DATABASE_URL is set, e.g.
 *   COPS_TEST_DATABASE_URL=postgresql://skout@127.0.0.1:5435/skout_test
 * The child process writes, then calls process.exit(1) before COMMIT or before publish.
 */
const url = process.env.COPS_TEST_DATABASE_URL;
const maybe = url ? describe : describe.skip;

const childScript = (mode: "before-commit" | "after-commit", id: string, tenant: string) => `
const postgres = require(${JSON.stringify(POSTGRES_PATH)});
const sql = postgres(process.env.COPS_TEST_DATABASE_URL, { max: 1 });
(async () => {
  const envelope = { event_id: "${id}", event_type: "OpportunityQualified" };
  if ("${mode}" === "before-commit") {
    await sql.begin(async (tx) => {
      await tx\`insert into cops_outbox (id, tenant_id, event_type, aggregate_type, aggregate_id, envelope)
                values (\${"${id}"}, \${"${tenant}"}, 'OpportunityQualified', 'opportunity', 'o1', \${sql.json(envelope)})\`;
      process.exit(1);
    });
  } else {
    await sql\`insert into cops_outbox (id, tenant_id, event_type, aggregate_type, aggregate_id, envelope)
              values (\${"${id}"}, \${"${tenant}"}, 'OpportunityQualified', 'opportunity', 'o1', \${sql.json(envelope)})\`;
    process.exit(1);
  }
})();
`;

maybe("COPS outbox survives a real process kill (Postgres)", () => {
  const dbUrl = url as string;
  const postgres = dbRequire("postgres") as typeof import("postgres");
  const sql = postgres(dbUrl, { max: 1 });
  // Own workspace so the test runs on any database (cops_outbox.tenant_id references workspaces).
  let tenant = "";
  const runChild = (mode: "before-commit" | "after-commit", id: string) =>
    spawnSync(process.execPath, ["-e", childScript(mode, id, tenant)], {
      env: { ...process.env, COPS_TEST_DATABASE_URL: dbUrl },
      cwd: process.cwd(),
      encoding: "utf8",
    });

  it("kill before commit leaves neither the row nor an effect", async () => {
    const [ws] = await sql`insert into workspaces (name, slug) values ('outbox kill test', ${"outbox-kill-" + Date.now() + "-" + Math.random()}) returning id`;
    tenant = ws.id as string;
    const id = "11111111-1111-4111-8111-111111111111";
    await sql`delete from cops_outbox where id = ${id}`;
    const res = runChild("before-commit", id);
    expect(res.status, res.stderr).toBe(1);
    expect(res.stderr).not.toMatch(/violates|ECONN|error/i);
    const rows = await sql`select id from cops_outbox where id = ${id}`;
    expect(rows.length).toBe(0);
  });

  it("kill after commit, before publish: the restarted relay publishes exactly once", async () => {
    const id = "22222222-2222-4222-8222-222222222222";
    await sql`delete from cops_outbox where id = ${id}`;
    const res = runChild("after-commit", id);
    expect(res.status, res.stderr).toBe(1);
    expect(res.stderr).not.toMatch(/violates|ECONN|error/i);

    const [row] = await sql`select id, attempts, envelope, published_at from cops_outbox where id = ${id}`;
    expect(row.published_at).toBeNull();

    const published: string[] = [];
    const publish = async (env: unknown) => {
      published.push((env as { event_id: string }).event_id);
    };
    const update = await relayCopsOutboxRow({ id: row.id, attempts: row.attempts, envelope: row.envelope }, publish);
    expect(update.kind).toBe("published");
    await sql`update cops_outbox set published_at = now() where id = ${id}`;

    // Second pass finds nothing due for this row.
    const pending = await sql`select id from cops_outbox where id = ${id} and published_at is null`;
    expect(pending.length).toBe(0);
    expect(published).toEqual(["22222222-2222-4222-8222-222222222222"]);
    await sql.end();
  });
});
