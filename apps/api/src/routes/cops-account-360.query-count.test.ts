import { afterAll, beforeAll, describe, expect, it } from "vitest";
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

const OWNER_EMAIL = "signup.tester1791282671@example.test";
const WORKSPACE_ID = "bb214f11-bdb4-4012-add2-dd471a078981";

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
    await app.ready();
    sql = postgres(url as string, { max: 1 });
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
