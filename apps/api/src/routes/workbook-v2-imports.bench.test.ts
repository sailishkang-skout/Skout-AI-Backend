import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { createDb, schema } from "@skout/db";
import { invalidateWorkspaceAccess } from "@skout/auth";
import { loadEnv } from "../config/env.js";
import { buildApp } from "../app.js";
import { startWorkbookImportWorker } from "../workers/workbook-import.worker.js";
import { MAX_IMPORT_BYTES } from "../services/workbook-import-csv.js";

/**
 * WB2-020 performance target (PRD section 10): 100,000 rows imported and visible in under 2 minutes. Measured through
 * HTTP, with the real queue and the worker in the same process as the API, as it is deployed: from the first byte of
 * the upload to a completed import whose rows the rows API returns.
 *
 * Skipped unless asked for. Use a throwaway database and a throwaway Redis:
 *   IMPORT_BENCHMARK=1 WORKBOOK_IMPORT_TEST_REDIS_URL=redis://localhost:56379 DATABASE_URL=postgresql://.../wb_bench \
 *     npx vitest run src/routes/workbook-v2-imports.bench.test.ts
 * IMPORT_BENCHMARK_REPORT=<file> also writes the results as JSON.
 */
const base = loadEnv();
const redisUrl = process.env.WORKBOOK_IMPORT_TEST_REDIS_URL;
const enabled = process.env.IMPORT_BENCHMARK === "1" && Boolean(base.DATABASE_URL) && Boolean(redisUrl);
const ROWS = 100_000;
const TARGET_MS = 120_000;
const HEADERS = ["First name", "Last name", "Email", "LinkedIn URL", "Company", "Company domain", "Job title", "Phone", "Employees", "Notes"];

/** A lead list as a CRM would export it. Every 50th email repeats, differently capitalised. */
function leads(rows: number, from: number, noteLength: number): string {
  const note = "Met at the spring conference, asked for pricing; follow up. ".repeat(Math.ceil(noteLength / 60) + 1).slice(0, noteLength);
  const lines = [HEADERS.join(",")];
  for (let i = from; i < from + rows; i++) {
    const person = i % 50 === 49 ? i - 1 : i;
    const email = `person${person}@company${person % 9_000}.com`;
    lines.push(
      [
        `First${i}`,
        `Last${i}`,
        person === i ? email : email.toUpperCase(),
        `https://www.linkedin.com/in/person-${i}`,
        `"Company ${i % 9_000}, Inc."`,
        `company${i % 9_000}.com`,
        "Head of Operations",
        `+44 20 7946 ${String(i % 10_000).padStart(4, "0")}`,
        String(10 + (i % 5_000)),
        `"${note}"`,
      ].join(",")
    );
  }
  return `${lines.join("\n")}\n`;
}

describe.skipIf(!enabled)("WB2-020 CSV import benchmark (100,000 rows x 10 columns)", () => {
  const { db, sql } = createDb(base.DATABASE_URL!);
  const suffix = Math.random().toString(36).slice(2, 10);
  const email = `wb2-import-bench-${suffix}@test.com`;
  const results: Array<Record<string, unknown>> = [];
  const config = { ...base, REDIS_URL: redisUrl!, CLERK_SECRET_KEY: undefined, LOG_LEVEL: "fatal" as const, OPENSEARCH_URL: undefined, EXPORTS_BUCKET: undefined, RATE_LIMIT_MAX: 1_000_000 };
  const previousDir = process.env.WORKBOOK_IMPORTS_LOCAL_DIR;
  let app: Awaited<ReturnType<typeof buildApp>>;
  let stop: () => Promise<void>;
  let origin: string;
  let dir: string;
  let workspaceId: string;

  beforeAll(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "wb2-import-bench-"));
    process.env.WORKBOOK_IMPORTS_LOCAL_DIR = dir;
    app = await buildApp(config);
    origin = await app.listen({ port: 0, host: "127.0.0.1" });
    await fetch(`${origin}/api/v1/me`, { headers: { "x-stub-user-email": email } });
    const [u] = await db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.email, email));
    const [m] = await db.select().from(schema.workspaceMembers).where(eq(schema.workspaceMembers.userId, u!.id));
    workspaceId = m!.workspaceId;
    await db.update(schema.workspaces).set({ accessStatus: "active" }).where(eq(schema.workspaces.id, workspaceId));
    await db.insert(schema.entitlements).values([
      { workspaceId, key: "feature.workbooks_v2", value: true, source: "test" },
      { workspaceId, key: "workbooks.row_limit", value: 250_000, source: "test" },
    ]);
    invalidateWorkspaceAccess(workspaceId);
    stop = await startWorkbookImportWorker(config);
  });
  afterAll(async () => {
    const report = process.env.IMPORT_BENCHMARK_REPORT;
    if (report) writeFileSync(report, JSON.stringify(results, null, 2));
    await stop?.();
    await app?.close();
    await db.delete(schema.workbooks).where(eq(schema.workbooks.workspaceId, workspaceId));
    await sql.end();
    if (previousDir === undefined) delete process.env.WORKBOOK_IMPORTS_LOCAL_DIR;
    else process.env.WORKBOOK_IMPORTS_LOCAL_DIR = previousDir;
    await rm(dir, { recursive: true, force: true });
  });

  const api = async (method: string, p: string, body?: unknown) => {
    const res = await fetch(`${origin}/api/v1/workbooks-v2${p}`, {
      method,
      headers: { "x-stub-user-email": email, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, json: (await res.json()) as any };
  };
  const newWorkbook = async () => (await api("POST", "", { name: "Benchmark" })).json.data.id as string;
  const percentile = (values: number[], p: number) => [...values].sort((a, z) => a - z)[Math.min(values.length - 1, Math.floor((values.length * p) / 100))] ?? 0;

  async function runImport(scenario: string, workbookId: string, text: string, dedupe: "email" | "linkedin_url" | "none", columns?: unknown[]) {
    const bytes = Buffer.from(text);
    const rssBefore = process.memoryUsage().rss;
    let peakRss = rssBefore;
    const memory = setInterval(() => (peakRss = Math.max(peakRss, process.memoryUsage().rss)), 50);
    const started = performance.now();
    const upload = await fetch(`${origin}/api/v1/workbooks-v2/${workbookId}/imports`, {
      method: "POST",
      headers: { "x-stub-user-email": email, "content-type": "text/csv", "x-file-name": "leads.csv" },
      body: bytes,
    });
    const uploaded = ((await upload.json()) as any).data;
    expect(upload.status).toBe(201);
    const previewMs = performance.now() - started;
    const mapping = columns ?? uploaded.preview.suggestions.map((s: any) => ({ header: s.header, ...s.target }));
    const confirmStarted = performance.now();
    const confirmed = await api("POST", `/${workbookId}/imports/${uploaded.id}/confirm`, { columns: mapping, dedupe: { key: dedupe } });
    expect(confirmed.status, JSON.stringify(confirmed.json)).toBe(202);
    const confirmMs = performance.now() - confirmStarted;

    // While it runs: what someone using the workbook sees.
    const progress: number[] = [];
    const writes: number[] = [];
    const reads: number[] = [];
    let status = confirmed.json.data;
    const nameColumn = status.mapping.columns[0].columnId as string;
    let handRows = 0;
    while (status.status === "queued" || status.status === "processing") {
      let t = performance.now();
      const add = await api("POST", `/${workbookId}/rows`, { cells: { [nameColumn]: "added by hand" } });
      writes.push(performance.now() - t);
      expect(add.status).toBe(201);
      handRows += 1;
      t = performance.now();
      expect((await api("GET", `/${workbookId}/rows?limit=200`)).status).toBe(200);
      reads.push(performance.now() - t);
      await new Promise((resolve) => setTimeout(resolve, 500));
      status = (await api("GET", `/${workbookId}/imports/${uploaded.id}`)).json.data;
      progress.push(status.progress);
      expect(performance.now() - started, "still running far past the target").toBeLessThan(TARGET_MS * 2);
    }
    const window = await api("GET", `/${workbookId}/rows?limit=200`);
    const totalMs = performance.now() - started;
    clearInterval(memory);

    expect(status.status, JSON.stringify(status.error)).toBe("completed");
    expect(status.counts.processed).toBe(status.counts.total);
    expect([...progress].sort((a, z) => a - z)).toEqual(progress);
    const [rows] = await sql`select count(*)::int as n from workbook_rows where workbook_id = ${workbookId} and source->>'importId' = ${uploaded.id}`;
    expect(rows!.n).toBe(status.counts.imported);
    const result = {
      scenario,
      fileMB: Number((bytes.length / 1024 / 1024).toFixed(1)),
      counts: status.counts,
      uploadAndPreviewMs: Math.round(previewMs),
      confirmMs: Math.round(confirmMs),
      totalMs: Math.round(totalMs),
      rowsPerSecond: Math.round(status.counts.total / ((totalMs - previewMs) / 1000)),
      workbookRows: window.json.window.total,
      handRows,
      handWriteMs: { p50: Math.round(percentile(writes, 50)), max: Math.round(percentile(writes, 100)) },
      windowReadMs: { p50: Math.round(percentile(reads, 50)), max: Math.round(percentile(reads, 100)) },
      progressSeen: progress.length,
      peakRssGrowthMB: Math.round((peakRss - rssBefore) / 1024 / 1024),
    };
    results.push(result);
    console.log(`IMPORT ${JSON.stringify(result)}`);
    expect(totalMs).toBeLessThan(TARGET_MS);
    return { result, uploaded, status };
  }

  it("imports a representative 100,000-row file with email deduplication", async () => {
    const workbookId = await newWorkbook();
    const { status } = await runImport("empty workbook, dedupe by email", workbookId, leads(ROWS, 0, 40), "email");
    expect(status.counts).toMatchObject({ total: ROWS, imported: ROWS - ROWS / 50, duplicates: ROWS / 50, failed: 0 });
  }, 400_000);

  it("imports 100,000 rows close to 50 MB, then 100,000 more against them", async () => {
    const workbookId = await newWorkbook();
    const text = leads(ROWS, 0, 330);
    expect(Buffer.byteLength(text)).toBeGreaterThan(45 * 1024 * 1024);
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(MAX_IMPORT_BYTES);
    const first = await runImport("close to 50 MB, no deduplication", workbookId, text, "none");
    expect(first.status.counts.imported).toBe(ROWS);
    // Half of these people are already in the workbook.
    const columns = first.status.mapping.columns.map((c: any) => ({ header: c.header, columnId: c.columnId }));
    const second = await runImport("100,000 existing rows, dedupe by LinkedIn URL", workbookId, leads(ROWS, ROWS / 2, 40), "linkedin_url", columns);
    expect(second.status.counts).toMatchObject({ imported: ROWS / 2, duplicates: ROWS / 2 });
  }, 600_000);
});
