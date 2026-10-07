import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import type { FastifyInstance } from "fastify";
import { loadEnv } from "../config/env.js";
import { buildApp } from "../app.js";

/**
 * Query-count assertion for GET /accounts/:id/360 (ticket: "360 header + summaries load in one
 * request, query count asserted"). The count must not grow with the number of contacts or
 * timeline rows. Runs only when COPS_TEST_DATABASE_URL is set (real Postgres).
 */
const url = process.env.COPS_TEST_DATABASE_URL;
const maybe = url ? describe : describe.skip;

const postgres = createRequire(new URL("../../../../packages/db/package.json", import.meta.url))("postgres") as (url: string, options?: object) => any;

// The stub user is provisioned (with its own workspace) on its first request, so this runs on any database.
const OWNER_EMAIL = `query-count-${Date.now()}@example.test`;
let WORKSPACE_ID = "";

maybe("GET /accounts/:id/360 query count", () => {
  let app: FastifyInstance;
  let sql: any;
  let counting = false;
  let queries = 0;

  beforeAll(async () => {
    // Stub auth is what this test authenticates with (see account-360.routes.test.ts).
    delete process.env.AUTH_MODE;
    process.env.AUTH_STUB = "true";
    process.env.CLERK_SECRET_KEY = "";
    const config = loadEnv();
    app = await buildApp(
      { ...config, DATABASE_URL: url, CLERK_SECRET_KEY: undefined, LOG_LEVEL: "fatal", OPENSEARCH_URL: undefined } as typeof config,
      {
        onDbQuery: () => {
          if (counting) queries++;
        },
      }
    );
    sql = postgres(url as string, { max: 1 });
    // COPS routes read permissions from workspace_member_roles. On a database where the RBAC catalog
    // was never seeded every request is 403, so seed it with the repo's idempotent backfill first.
    const [roles] = await sql`select count(*)::int as n from roles where key = 'owner'`;
    if (roles.n === 0) {
      const backfill = spawnSync("npx", ["tsx", "src/backfill-rbac.ts"], {
        cwd: new URL("../../../../packages/db/", import.meta.url),
        env: { ...process.env, DATABASE_URL: url },
        shell: true,
        encoding: "utf8",
      });
      if (backfill.status !== 0) throw new Error(`backfill-rbac failed: ${backfill.stderr}`);
    }
    await app.ready();
    const me = await app.inject({ method: "GET", url: "/api/v1/me", headers: { "x-stub-user-email": OWNER_EMAIL } });
    WORKSPACE_ID = (me.json() as { workspaceId: string }).workspaceId;
  });

  afterAll(async () => {
    await app?.close();
    await sql?.end();
  });

  async function countFor(accountId: string): Promise<number> {
    counting = true;
    queries = 0;
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/accounts/${accountId}/360`,
      headers: { "x-stub-user-email": OWNER_EMAIL },
    });
    counting = false;
    expect(res.statusCode).toBe(200);
    return queries;
  }

  it("uses the same number of queries with 1 contact and with 21 contacts", async () => {
    const [company] = await sql`insert into companies (workspace_id, name) values (${WORKSPACE_ID}, ${"Query Count Co " + Date.now()}) returning id`;
    await sql`insert into contacts (workspace_id, company_id, first_name, email) values (${WORKSPACE_ID}, ${company.id}, 'First', ${"first." + Date.now() + "@example.test"})`;

    // First request also provisions the stub user and warms caches; measure after it.
    await countFor(company.id as string);
    const small = await countFor(company.id as string);

    const rows = Array.from({ length: 20 }, (_, i) => ({
      workspace_id: WORKSPACE_ID,
      company_id: company.id,
      first_name: `Bulk${i}`,
      email: `bulk${i}.${Date.now()}@example.test`,
    }));
    await sql`insert into contacts ${sql(rows, "workspace_id", "company_id", "first_name", "email")}`;

    const large = await countFor(company.id as string);

    expect(large).toBe(small);
    // Measured constant: 21 statements per request, including auth and middleware. The bound
    // guards against a regression that adds per-row queries (N+1); the equality above is the real check.
    expect(large).toBeLessThanOrEqual(25);
  });
});
