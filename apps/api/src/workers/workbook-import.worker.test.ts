import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Queue } from "bullmq";
import { eq } from "drizzle-orm";
import { createDb, schema } from "@skout/db";
import { invalidateWorkspaceAccess } from "@skout/auth";
import { loadEnv } from "../config/env.js";
import { buildApp } from "../app.js";
import { redisBullMqConnection } from "../lib/redis.js";
import { withFailingCellInserts } from "../test/failing-cell-inserts.js";
import { WORKBOOK_IMPORT_QUEUE, closeWorkbookImportQueue, workbookImportQueue } from "./workbook-import.queue.js";
import { startWorkbookImportWorker } from "./workbook-import.worker.js";

/**
 * WB2-020: the background queue and worker.
 *
 * The first test needs no Redis. The rest run only against a Redis that is safe to fill with test jobs:
 *   WORKBOOK_IMPORT_TEST_REDIS_URL=redis://localhost:56379 DATABASE_URL=postgresql://... npx vitest run src/workers/workbook-import.worker.test.ts
 */
const base = loadEnv();
const redisUrl = process.env.WORKBOOK_IMPORT_TEST_REDIS_URL;

describe("the import queue without Redis", () => {
  afterAll(closeWorkbookImportQueue);

  it("says it is not ready, in seconds rather than waiting for Redis to appear", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const started = Date.now();
    await expect(workbookImportQueue({ ...base, REDIS_URL: "redis://127.0.0.1:1" }).ready()).resolves.toBe(false);
    expect(Date.now() - started).toBeLessThan(6_000);
    warn.mockRestore();
  });
});

describe.skipIf(!redisUrl || !base.DATABASE_URL)("the import worker with Redis", () => {
  const { db, sql } = createDb(base.DATABASE_URL!);
  const suffix = Math.random().toString(36).slice(2, 10);
  const config = { ...base, REDIS_URL: redisUrl!, CLERK_SECRET_KEY: undefined, LOG_LEVEL: "fatal" as const, OPENSEARCH_URL: undefined, EXPORTS_BUCKET: undefined, RATE_LIMIT_MAX: 10_000 };
  const previousDir = process.env.WORKBOOK_IMPORTS_LOCAL_DIR;
  const email = `wb2-worker-${suffix}@test.com`;
  const headers = { "x-stub-user-email": email };
  let app: Awaited<ReturnType<typeof buildApp>>;
  let stop: () => Promise<void>;
  let dir: string;
  let workspaceId: string;

  beforeAll(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "wb2-worker-test-"));
    process.env.WORKBOOK_IMPORTS_LOCAL_DIR = dir;
    app = await buildApp(config);
    await app.inject({ method: "GET", url: "/api/v1/me", headers });
    const [u] = await db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.email, email));
    const [m] = await db.select().from(schema.workspaceMembers).where(eq(schema.workspaceMembers.userId, u!.id));
    workspaceId = m!.workspaceId;
    await db.update(schema.workspaces).set({ accessStatus: "active" }).where(eq(schema.workspaces.id, workspaceId));
    await db.insert(schema.entitlements).values({ workspaceId, key: "feature.workbooks_v2", value: true, source: "test" });
    invalidateWorkspaceAccess(workspaceId);
    stop = await startWorkbookImportWorker(config);
  });
  afterAll(async () => {
    await stop?.();
    await app?.close();
    await sql.end();
    if (previousDir === undefined) delete process.env.WORKBOOK_IMPORTS_LOCAL_DIR;
    else process.env.WORKBOOK_IMPORTS_LOCAL_DIR = previousDir;
    await rm(dir, { recursive: true, force: true });
  });

  async function upload(rows: string[]) {
    const book = await app.inject({ method: "POST", url: "/api/v1/workbooks-v2", headers: { ...headers, "content-type": "application/json" }, payload: JSON.stringify({ name: "Worker" }) });
    const workbookId = book.json().data.id as string;
    const res = await app.inject({ method: "POST", url: `/api/v1/workbooks-v2/${workbookId}/imports`, headers: { ...headers, "content-type": "text/csv", "x-file-name": "w.csv" }, payload: `Name\n${rows.join("\n")}\n` });
    expect(res.statusCode, res.body).toBe(201);
    return { workbookId, importId: res.json().data.id as string };
  }
  const confirm = (workbookId: string, importId: string) =>
    app.inject({
      method: "POST",
      url: `/api/v1/workbooks-v2/${workbookId}/imports/${importId}/confirm`,
      headers: { ...headers, "content-type": "application/json" },
      payload: JSON.stringify({ columns: [{ header: 0, newColumn: { name: "Name", dataType: "text" } }], dedupe: { key: "none" } }),
    });
  const record = async (importId: string) => (await db.select().from(schema.workbookImports).where(eq(schema.workbookImports.id, importId)))[0]!;
  const rowsIn = async (workbookId: string) => (await db.select({ id: schema.workbookRows.id }).from(schema.workbookRows).where(eq(schema.workbookRows.workbookId, workbookId))).length;
  const finished = (importId: string, status: string) => vi.waitFor(async () => expect((await record(importId)).status).toBe(status), { timeout: 60_000, interval: 100 });

  it("imports a queued file in the background", async () => {
    const { workbookId, importId } = await upload(Array.from({ length: 3_500 }, (_, i) => `n${i}`));
    const res = await confirm(workbookId, importId);
    expect(res.statusCode, res.body).toBe(202);
    await finished(importId, "completed");
    expect(await rowsIn(workbookId)).toBe(3_500);
    expect((await record(importId)).fileKey).toBeNull();
  });

  it("holds one job per import, and can queue it again after it has run", async () => {
    const queue = new Queue(WORKBOOK_IMPORT_QUEUE, { connection: redisBullMqConnection(redisUrl!) });
    await queue.pause();
    const importId = randomUUID();
    await workbookImportQueue(config).enqueue({ importId, workspaceId });
    await workbookImportQueue(config).enqueue({ importId, workspaceId });
    expect((await queue.getJobs(["waiting", "paused", "delayed"])).filter((j) => j.data.importId === importId)).toHaveLength(1);
    await queue.resume();
    // An id that names no import is finished with at once, and its job is removed.
    await vi.waitFor(async () => expect(await queue.getJob(importId)).toBeUndefined(), { timeout: 20_000 });
    await queue.pause();
    await workbookImportQueue(config).enqueue({ importId, workspaceId });
    expect(await queue.getJob(importId)).toBeDefined();
    await queue.resume();
    await queue.close();
  });

  it("retries a failing job and marks the import failed only after the last attempt", async () => {
    const boom = `boom-${suffix}`;
    const rows = Array.from({ length: 1_500 }, (_, i) => (i === 1_200 ? boom : `n${i}`));
    const { workbookId, importId } = await upload(rows);
    const queue = new Queue(WORKBOOK_IMPORT_QUEUE, { connection: redisBullMqConnection(redisUrl!) });
    await queue.pause();
    expect((await confirm(workbookId, importId)).statusCode).toBe(202);
    // The same job with a short backoff, so the test does not wait for the real one.
    await (await queue.getJob(importId))!.remove();
    await withFailingCellInserts(sql, `wb2_worker_boom_${suffix}`, `new.value = '"${boom}"'::jsonb`, async () => {
      await queue.add("import-csv", { importId, workspaceId }, { jobId: importId, attempts: 3, backoff: { type: "fixed", delay: 500 }, removeOnComplete: true, removeOnFail: true });
      await queue.resume();
      await vi.waitFor(async () => expect((await record(importId)).status).toBe("processing"), { timeout: 20_000, interval: 20 });
      await finished(importId, "failed");
    });
    await queue.close();
    expect(await record(importId)).toMatchObject({ error: { code: "IMPORT_FAILED" }, fileKey: null });
    expect(await rowsIn(workbookId)).toBe(1_000);
  });
});
