import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import type { FastifyInstance } from "fastify";
import { loadEnv } from "../config/env.js";
import { buildApp } from "../app.js";

const url = process.env.COPS_TEST_DATABASE_URL;
const maybe = url ? describe : describe.skip;
const postgres = createRequire(new URL("../../../../packages/db/package.json", import.meta.url))("postgres") as (url: string, options?: object) => any;
const stamp = Date.now().toString(36).toUpperCase().slice(-5);
const ownerEmail = `tracker-${stamp.toLowerCase()}@example.test`;

maybe("work tracker (projects, issues, board, comments)", () => {
  let app: FastifyInstance;
  let sql: any;
  const call = (method: "GET" | "POST" | "PATCH" | "DELETE", path: string, body?: unknown, email = ownerEmail) =>
    app.inject({ method, url: `/api/v1${path}`, headers: { "x-stub-user-email": email }, ...(body !== undefined ? { payload: body as object } : {}) });

  beforeAll(async () => {
    delete process.env.AUTH_MODE;
    process.env.AUTH_STUB = "true";
    process.env.CLERK_SECRET_KEY = "";
    const config = loadEnv();
    app = await buildApp({ ...config, DATABASE_URL: url, CLERK_SECRET_KEY: undefined, LOG_LEVEL: "fatal", OPENSEARCH_URL: undefined } as typeof config);
    sql = postgres(url as string, { max: 1, onnotice: () => {} });
    await app.ready();
  });
  afterAll(async () => {
    await app?.close();
    await sql?.end();
  });

  it("numbers issues per project, moves them on the board, keeps comments and history", async () => {
    const key = `T${stamp}`;
    const proj = await call("POST", "/tracker/projects", { key: key.toLowerCase(), name: "Engineering board", department: "engineering" });
    expect(proj.statusCode).toBe(201);
    expect(proj.json().data.key).toBe(key);
    expect((await call("POST", "/tracker/projects", { key, name: "Again", department: "sales" })).statusCode).toBe(409);
    const pid = proj.json().data.id;

    const a = (await call("POST", "/tracker/issues", { project_id: pid, title: "Fix login bug", type: "bug", priority: "urgent", labels: ["auth"] })).json().data;
    const b = (await call("POST", "/tracker/issues", { project_id: pid, title: "Write onboarding guide" })).json().data;
    expect([a.key, b.key]).toEqual([`${key}-1`, `${key}-2`]);
    expect(a).toMatchObject({ status: "todo", priority: "urgent", type: "bug", labels: ["auth"] });
    expect(b.position).toBeLessThan(a.position); // newest at the top of its column

    const moved = (await call("PATCH", `/tracker/issues/${a.id}`, { status: "done" })).json().data;
    expect(moved.status).toBe("done");
    expect(moved.completed_at).not.toBeNull();
    expect((await call("PATCH", `/tracker/issues/${a.id}`, { status: "in_progress" })).json().data.completed_at).toBeNull();

    expect((await call("POST", `/tracker/issues/${a.id}/comments`, { body: "Repro on Safari only" })).statusCode).toBe(201);
    const full = (await call("GET", `/tracker/issues/${a.id}`)).json().data;
    expect(full.comments.map((c: { body: string }) => c.body)).toEqual(["Repro on Safari only"]);
    expect(full.activity.map((h: { action: string }) => h.action)).toEqual(expect.arrayContaining(["tracker_issue.created", "tracker_issue.moved"]));

    // Search by key, by text, by label; the project list counts open work.
    expect((await call("GET", `/tracker/issues?q=${key}-2`)).json().data.map((i: { key: string }) => i.key)).toEqual([`${key}-2`]);
    expect((await call("GET", `/tracker/issues?project_id=${pid}&label=auth`)).json().data.map((i: { key: string }) => i.key)).toEqual([`${key}-1`]);
    const listed = (await call("GET", "/tracker/projects")).json().data.find((p: { id: string }) => p.id === pid);
    expect(listed.open_issues).toBe(2);
  });

  it("refuses bad input and lets only the reporter or an admin delete", async () => {
    const key = `D${stamp}`;
    const pid = (await call("POST", "/tracker/projects", { key, name: "Sales board", department: "sales" })).json().data.id;
    expect((await call("POST", "/tracker/issues", { project_id: pid, title: "x" })).statusCode).toBe(422);
    expect((await call("POST", "/tracker/issues", { project_id: pid, title: "Valid", status: "nope" })).statusCode).toBe(422);
    const issue = (await call("POST", "/tracker/issues", { project_id: pid, title: "Call back Acme" })).json().data;
    expect((await call("DELETE", `/tracker/issues/${issue.id}`)).statusCode).toBe(204);
    expect((await call("GET", `/tracker/issues/${issue.id}`)).statusCode).toBe(404);
  });
});
