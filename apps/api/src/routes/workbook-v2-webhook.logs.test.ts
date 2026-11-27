import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { createDb, schema } from "@skout/db";
import { invalidateWorkspaceAccess } from "@skout/auth";
import { loadEnv } from "../config/env.js";
import { buildApp } from "../app.js";
import { withFailingCellInserts } from "../test/failing-cell-inserts.js";

/**
 * WB2-026: nothing sent to a webhook, and no token, reaches the logs. The loggers write to standard output, which is
 * captured here from before they are made, with everything down to `trace` turned on.
 */
const logs = await vi.hoisted(async () => {
  const written: string[] = [];
  const original = process.stdout.write;
  const level = process.env.LOG_LEVEL;
  process.env.LOG_LEVEL = "trace";
  process.stdout.write = function capture(chunk: unknown, ...rest: unknown[]) {
    const text = String(chunk);
    if (!text.startsWith("{")) return (original as (...args: unknown[]) => boolean).call(process.stdout, chunk, ...rest);
    written.push(text);
    return true;
  } as typeof process.stdout.write;
  // The test setup may have made the shared logger already; it is made again, writing to the capture.
  const { initRootLogger } = await import("@skout/observability");
  initRootLogger({ service: "skout-api", level: "trace" });
  return {
    written,
    restore: () => {
      process.stdout.write = original;
      if (level === undefined) delete process.env.LOG_LEVEL;
      else process.env.LOG_LEVEL = level;
    },
  };
});

const base = loadEnv();
const hasDatabase = Boolean(base.DATABASE_URL);

describe.skipIf(!hasDatabase)("Workbooks V2 inbound webhook logging", () => {
  const { db, sql } = createDb(base.DATABASE_URL!);
  const suffix = Math.random().toString(36).slice(2, 10);
  const config = { ...base, CLERK_SECRET_KEY: undefined, LOG_LEVEL: "trace" as const, RATE_LIMIT_MAX: 100_000, PLATFORM_ADMIN_EMAILS: [] };
  let app: Awaited<ReturnType<typeof buildApp>>;

  beforeAll(async () => {
    app = await buildApp(config);
  });
  afterAll(async () => {
    await app.close();
    await sql.end();
    logs.restore();
  });

  it("writes no token and nothing that was sent, whether a request succeeds or fails", async () => {
    const email = `wb2-webhook-logs-${suffix}@test.com`;
    const headers = { "x-stub-user-email": email };
    await app.inject({ method: "GET", url: "/api/v1/me", headers });
    const [u] = await db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.email, email));
    const [m] = await db.select().from(schema.workspaceMembers).where(eq(schema.workspaceMembers.userId, u!.id));
    const workspaceId = m!.workspaceId;
    await db.update(schema.workspaces).set({ accessStatus: "active" }).where(eq(schema.workspaces.id, workspaceId));
    await db.insert(schema.entitlements).values({ workspaceId, key: "feature.workbooks_v2", value: true, source: "test" });
    invalidateWorkspaceAccess(workspaceId);

    const manage = (method: "POST", path: string, body?: unknown) =>
      app.inject({ method, url: `/api/v1/workbooks-v2${path}`, headers: { ...headers, ...(body ? { "content-type": "application/json" } : {}) }, ...(body ? { payload: JSON.stringify(body) } : {}) });
    const workbookId = (await manage("POST", "", { name: "Logs" })).json().data.id as string;
    await db.insert(schema.workbookColumns).values({ id: randomUUID(), workbookId, name: "Name", type: "input", position: 0, config: { dataType: "text" } });
    const { webhook, token } = (await manage("POST", `/${workbookId}/webhook`)).json().data;
    const next = (await manage("POST", `/${workbookId}/webhook/regenerate`)).json().data.token as string;

    logs.written.length = 0;
    const post = (payload: string, auth = next, extra: Record<string, string> = {}) =>
      app.inject({ method: "POST", url: `/api/v1/webhooks/workbooks/${webhook.id}`, headers: { authorization: `Bearer ${auth}`, "content-type": "application/json", ...extra }, payload });
    const good = JSON.stringify([{ Name: "payload-secret-name", "payload-secret-field": "payload-secret-other" }]);

    const statuses = [
      (await post(good)).statusCode,
      (await post(good, next, { "idempotency-key": `logs-${suffix}-key` })).statusCode,
      (await post(good, token)).statusCode,
      (await post("payload-secret-broken")).statusCode,
      (await post('[{"Name": "payload-secret-cut"')).statusCode,
      (await post('{"Name": "payload-secret-object"}')).statusCode,
      (await post(good, next, { "content-type": "text/plain" })).statusCode,
      (await post(JSON.stringify([{ Name: "payload-secret-" + "x".repeat(6 * 1024 * 1024) }]))).statusCode,
      (await withFailingCellInserts(sql, `wb2_webhook_logs_${suffix}`, `new.value::text like '%payload-secret-boom-${suffix}%'`, async () => post(JSON.stringify([{ Name: `payload-secret-boom-${suffix}` }])))).statusCode,
    ];
    for (let i = 0; i < 60; i++) statuses.push((await post(good)).statusCode);
    expect(statuses.slice(0, 9)).toEqual([200, 200, 401, 400, 400, 422, 415, 413, 500]);
    expect(statuses.at(-1)).toBe(429);
    // Response lines are written after the reply.
    await new Promise((resolve) => setTimeout(resolve, 100));

    const all = logs.written.join("");
    // The capture works: the requests and the failure are there.
    expect(all).toContain("request completed");
    expect(all).toContain(webhook.id);
    expect(all).toContain("webhook request failed");
    expect(all).not.toContain("payload-secret");
    expect(all).not.toContain("skwh_");
    for (const secret of [token, next]) expect(all).not.toContain(secret.slice(5));
  });
});
