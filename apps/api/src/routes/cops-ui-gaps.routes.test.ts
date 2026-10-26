import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { loadEnv } from "../config/env.js";
import { buildApp } from "../app.js";

/**
 * Endpoints the CustomerOps panel needed that the API did not offer yet (skout-customerops
 * docs/backend-gaps.md), against a real Postgres. Runs only when COPS_TEST_DATABASE_URL is set.
 */
const url = process.env.COPS_TEST_DATABASE_URL;
const maybe = url ? describe : describe.skip;
const postgres = createRequire(new URL("../../../../packages/db/package.json", import.meta.url))("postgres") as (url: string, options?: object) => any;

const OWNER = `gaps-owner-${Date.now().toString(36)}@example.test`;

maybe("CustomerOps panel gaps", () => {
  let app: FastifyInstance;
  let sql: any;
  let workspaceId = "";
  let userId = "";

  const call = (method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE", path: string, body?: unknown, key: string | null = randomUUID()) =>
    app.inject({
      method,
      url: `/api/v1${path}`,
      headers: { "x-stub-user-email": OWNER, ...(method !== "GET" && key ? { "idempotency-key": key } : {}) },
      ...(body !== undefined ? { payload: body as object } : {}),
    });

  async function asRole(roleKey: string) {
    const [role] = await sql`select id from roles where key = ${roleKey} and workspace_id is null`;
    await sql`delete from workspace_member_roles where workspace_id = ${workspaceId} and user_id = ${userId}`;
    await sql`insert into workspace_member_roles (workspace_id, user_id, role_id) values (${workspaceId}, ${userId}, ${role.id})`;
  }

  async function company(name: string) {
    const [row] = await sql`insert into companies (workspace_id, name, owner_id) values (${workspaceId}, ${name}, ${userId}) returning id`;
    return row.id as string;
  }

  beforeAll(async () => {
    process.env.COPS_DOCUMENTS_LOCAL_DIR = mkdtempSync(path.join(tmpdir(), "cops-docs-"));
    delete process.env.AUTH_MODE;
    process.env.AUTH_STUB = "true";
    process.env.CLERK_SECRET_KEY = "";
    const config = loadEnv();
    // No bucket: contract files go to the temp folder above instead of object storage.
    app = await buildApp({ ...config, DATABASE_URL: url, CLERK_SECRET_KEY: undefined, LOG_LEVEL: "fatal", OPENSEARCH_URL: undefined, EXPORTS_BUCKET: undefined, CONTRACTS_BUCKET: undefined } as typeof config);
    sql = postgres(url as string, { max: 1, onnotice: () => {} });
    await app.ready();
    workspaceId = ((await call("GET", "/me")).json() as { workspaceId: string }).workspaceId;
    const [u] = await sql`select id from users where email = ${OWNER}`;
    userId = u.id;
  });

  afterAll(async () => {
    await app?.close();
    await sql?.end();
  });

  it("gap 2: Sales reads the price book; Engineering does not; nobody but an admin changes it", async () => {
    await asRole("sales");
    const book = await call("GET", "/price-book");
    expect(book.statusCode).toBe(200);
    expect(book.json().data).toMatchObject({ currencies: expect.any(Object), month_to_month_surcharge_pct: expect.any(Number) });
    expect(book.json().data.currency_policy).not.toBeNull();
    expect((await call("PUT", "/admin/config/price_book/default", { value: book.json().data, reason: "x" })).statusCode).toBe(403);
    await asRole("engineering");
    expect((await call("GET", "/price-book")).statusCode).toBe(403);
  });

  it("gap 3: the 360 header carries onboarding % from the activation instance", async () => {
    await asRole("owner");
    const accountId = await company("Gap Three Ltd");
    const before = await call("GET", `/accounts/${accountId}/360?fields=header`);
    expect(before.json().data.header.onboarding_pct).toBeNull();
    const [tpl] = await sql`select id, key, version from cops_activation_templates where workspace_id is null order by version desc limit 1`;
    await sql`insert into cops_onboarding_instances (workspace_id, account_id, template_id, template_key, template_version, activation_pct)
              values (${workspaceId}, ${accountId}, ${tpl.id}, ${tpl.key}, ${tpl.version}, 40)`;
    const after = await call("GET", `/accounts/${accountId}/360?fields=header`);
    expect(after.json().data.header.onboarding_pct).toBe(40);
  });

  it("gap 6: a published automation turns off and on, is audited, and a draft cannot be turned on", async () => {
    await asRole("owner");
    const draft = (await call("POST", "/automations", { name: "Draft only" })).json().data;
    const refused = await call("PATCH", `/automations/${draft.id}`, { status: "active" });
    expect(refused.statusCode).toBe(409);

    const auto = (await call("POST", "/automations", { name: "Low adoption playbook" })).json().data;
    const pub = await call("POST", `/automations/${auto.id}/versions/publish`, { graph: { nodes: [{ id: "n1", type: "delay", config: { seconds: 1 } }], edges: [] } });
    expect(pub.statusCode).toBe(201);
    const off = await call("PATCH", `/automations/${auto.id}`, { status: "paused" });
    expect(off.statusCode).toBe(200);
    expect(off.json().data.status).toBe("paused");
    const on = await call("PATCH", `/automations/${auto.id}`, { status: "active" });
    expect(on.json().data.status).toBe("active");
    const audits = await sql`select action from audit_logs where workspace_id = ${workspaceId} and entity_id = ${auto.id} order by created_at`;
    expect(audits.map((a: { action: string }) => a.action)).toEqual(["automation.paused", "automation.activated"]);

    await asRole("sales");
    expect((await call("PATCH", `/automations/${auto.id}`, { status: "paused" })).statusCode).toBe(403);
  });

  it("gap 4: the workspace timeline lists every account, pages, filters and hides internal notes", async () => {
    await asRole("owner");
    const a = await company("Feed A");
    const b = await company("Feed B");
    const row = (account: string, type: string, visibility: string, minutes: number) =>
      sql`insert into cops_timeline_events (workspace_id, account_id, type, visibility, occurred_at, actor_type, source_event_id, event_type, summary)
          values (${workspaceId}, ${account}, ${type}, ${visibility}, now() - make_interval(mins => ${minutes}), 'user', ${randomUUID()}, 'cops.Test', ${type + " " + minutes})`;
    await row(a, "note", "internal", 1);
    await row(a, "email", "public", 2);
    await row(b, "call", "public", 3);

    const all = (await call("GET", "/cops/timeline?limit=2")).json();
    expect(all.data).toHaveLength(2);
    expect(all.data[0]).toMatchObject({ account_id: a, type: "note" });
    expect(all.next_cursor).toEqual(expect.any(String));
    const rest = (await call("GET", `/cops/timeline?limit=2&cursor=${all.next_cursor}`)).json();
    expect(rest.data.map((e: { account_id: string }) => e.account_id)).toContain(b);

    expect((await call("GET", `/cops/timeline?account_id=${b}`)).json().data.every((e: { account_id: string }) => e.account_id === b)).toBe(true);
    expect((await call("GET", "/cops/timeline?type=call")).json().data.every((e: { type: string }) => e.type === "call")).toBe(true);
    expect((await call("GET", "/cops/timeline?account_id=nope")).statusCode).toBe(422);

    await asRole("sales");
    const visible = (await call("GET", "/cops/timeline")).json().data;
    expect(visible.some((e: { visibility: string }) => e.visibility === "internal")).toBe(false);
  });

  it("gap 5: the contact list says whether each email is verified, bounced or suppressed", async () => {
    await asRole("owner");
    const accountId = await company("Status Co");
    const tag = Date.now().toString(36);
    const person = async (first: string, email: string | null) => {
      const [row] = await sql`insert into contacts (workspace_id, company_id, first_name, email) values (${workspaceId}, ${accountId}, ${first}, ${email}) returning id`;
      return row.id as string;
    };
    const verified = await person("Vera", `vera-${tag}@status.test`);
    const bounced = await person("Bo", `bo-${tag}@status.test`);
    const blocked = await person("Sue", `Sue-${tag}@Status.test`);
    const plain = await person("Una", `una-${tag}@status.test`);
    const none = await person("Nobody", null);
    await sql`insert into contact_channels (workspace_id, contact_id, channel, value, verified) values (${workspaceId}, ${verified}, 'email', ${`vera-${tag}@status.test`}, true)`;
    await sql`insert into contact_channels (workspace_id, contact_id, channel, value, verified, bounce_status) values (${workspaceId}, ${bounced}, 'email', ${`bo-${tag}@status.test`}, true, 'hard')`;
    await sql`insert into suppressions (workspace_id, email) values (${workspaceId}, ${`sue-${tag}@status.test`})`;

    const list = (await call("GET", `/contacts?company_id=${accountId}&limit=100`)).json().data as { id: string; email_status: string }[];
    const status = Object.fromEntries(list.map((c) => [c.id, c.email_status]));
    expect(status).toEqual({ [verified]: "verified", [bounced]: "bounced", [blocked]: "suppressed", [plain]: "unverified", [none]: "none" });
    expect((await call("GET", `/contacts?company_id=${accountId}&fields=id,email_status`)).json().data[0]).toEqual({ id: expect.any(String), email_status: expect.any(String) });
  });

  it("gap 9: provider status lists payments, e-sign, email, Slack and Teams without secrets; admins only", async () => {
    await asRole("owner");
    const res = await call("GET", "/cops/integrations/status");
    expect(res.statusCode).toBe(200);
    const data = res.json().data as { key: string; status: string; missing: string[]; events_7d: number }[];
    expect(data.map((p) => p.key)).toEqual(["payments", "esign", "email", "slack", "teams"]);
    for (const p of data) expect(["connected", "partial", "sandbox", "not_configured"]).toContain(p.status);
    expect(JSON.stringify(data)).not.toMatch(/https?:\/\/|whsec_|rzp_/);

    await sql`update workspaces set slack_webhook_url = 'https://hooks.slack.test/x' where id = ${workspaceId}`;
    const slack = (await call("GET", "/cops/integrations/status")).json().data.find((p: { key: string }) => p.key === "slack");
    expect(slack).toMatchObject({ status: "connected", missing: [] });

    await asRole("sales");
    expect((await call("GET", "/cops/integrations/status")).statusCode).toBe(403);
  });

  it("gap 1: the browser uploads a contract straight to storage with a signed URL; the API only checks it", async () => {
    await asRole("sales");
    const pdf = Buffer.from("%PDF-1.4\n1 0 obj << >> endobj\ntrailer << >>\n%%EOF\n");
    const sha = createHash("sha256").update(pdf).digest("hex");
    const put = (u: string, body: Buffer) => app.inject({ method: "PUT", url: u, headers: { "content-type": "application/pdf" }, payload: body });
    // Files sit under their account and document type.
    const accountId = "0f9a2c4e-6b1d-4e8f-9a3c-5d7e1f2a4b6c";
    const at = { account_id: accountId, kind: "msa" };
    const ref = `cops-document:${accountId}/msa/${sha}`;

    const start = await call("POST", "/contracts/documents/uploads", { file_name: "msa.pdf", file_sha256: sha, bytes: pdf.length, ...at });
    expect(start.statusCode).toBe(201);
    const { upload, document_url } = start.json().data;
    expect(document_url).toBe(ref);
    // The place is part of the request: an upload without it is refused.
    expect((await call("POST", "/contracts/documents/uploads", { file_name: "msa.pdf", file_sha256: sha, bytes: pdf.length })).statusCode).toBe(422);
    expect(upload.method).toBe("PUT");
    // Not uploaded yet: confirm refuses.
    expect((await call("POST", `/contracts/documents/${sha}/confirm`, { file_name: "msa.pdf", ...at })).statusCode).toBe(422);
    // The signed URL takes only the file that was hashed, and needs no bearer token.
    expect((await put(upload.url, Buffer.from("%PDF-other"))).statusCode).toBe(400);
    expect((await put(upload.url.replace(/sig=[a-f0-9]+/, "sig=" + "0".repeat(64)), pdf)).statusCode).toBe(403);
    expect((await put(upload.url, pdf)).statusCode).toBe(200);

    const done = await call("POST", `/contracts/documents/${sha}/confirm`, { file_name: "msa.pdf", ...at });
    expect(done.statusCode).toBe(200);
    expect(done.json().data).toEqual({ document_url: ref, file_sha256: sha, file_name: "msa.pdf", bytes: pdf.length });

    // Opening it gives a short-lived link, not the file.
    const link = await call("GET", `/contracts/documents/${sha}?account_id=${accountId}&kind=msa`);
    expect(link.statusCode).toBe(200);
    const file = await app.inject({ method: "GET", url: link.json().data.url });
    expect(file.headers["content-type"]).toContain("application/pdf");
    expect(Buffer.from(file.rawPayload).equals(pdf)).toBe(true);
    expect((await call("GET", `/contracts/documents/${"0".repeat(64)}?account_id=${accountId}&kind=msa`)).statusCode).toBe(404);
    // Same file, wrong place: not found (it lives under msa, not dpa).
    expect((await call("GET", `/contracts/documents/${sha}?account_id=${accountId}&kind=dpa`)).statusCode).toBe(404);

    // A text file can be uploaded to its own signed URL but is refused at confirm.
    const txt = Buffer.from("hello, not a pdf");
    const txtSha = createHash("sha256").update(txt).digest("hex");
    const t = (await call("POST", "/contracts/documents/uploads", { file_name: "x.txt", file_sha256: txtSha, bytes: txt.length, ...at })).json().data;
    await put(t.upload.url, txt);
    expect((await call("POST", `/contracts/documents/${txtSha}/confirm`, { file_name: "x.txt", ...at })).statusCode).toBe(422);
    expect((await call("POST", "/contracts/documents/uploads", { file_name: "big.pdf", file_sha256: sha, bytes: 11 * 1024 * 1024, ...at })).statusCode).toBe(422);
    const audits = await sql`select count(*)::int as n from audit_logs where workspace_id = ${workspaceId} and action = 'contract_document.uploaded'`;
    expect(audits[0].n).toBe(1);

    await asRole("engineering");
    expect((await call("GET", `/contracts/documents/${sha}?account_id=${accountId}&kind=msa`)).statusCode).toBe(403);
    expect((await call("POST", "/contracts/documents/uploads", { file_name: "msa.pdf", file_sha256: sha, bytes: pdf.length, ...at })).statusCode).toBe(403);
  });
});
