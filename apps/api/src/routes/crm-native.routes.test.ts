import { afterAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDb, schema } from "@skout/db";
import { loadEnv } from "../config/env.js";
import { buildApp } from "../app.js";
import { resolveOrProvisionUser } from "../services/auth.service.js";

async function buildTestApp() {
  const config = loadEnv();
  return buildApp({
    ...config,
    CLERK_SECRET_KEY: undefined,
    LOG_LEVEL: "fatal",
    OPENSEARCH_URL: undefined,
  });
}

function json(email: string) {
  return { "x-stub-user-email": email, "content-type": "application/json" };
}

// Section 7.1 DOCUMENTED READ-MODEL EXCEPTION — seeds/reads `contacts` (apps/crm-owned) directly
// via a real db connection to set up fixtures for the route under test, matching the exception
// already established for this table in crm-native-entity.service.ts (see its doc comment) and
// docs/adr/0003-read-model-exceptions.md; not itself a new exception, just test-fixture plumbing
// for one that already exists.
const { contacts } = schema;
const config = loadEnv();
const { db, sql } = createDb(config.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5432/skout");
const seededContactIds: string[] = [];

afterAll(async () => {
  for (const id of seededContactIds) {
    await db.delete(contacts).where(eq(contacts.id, id)).catch(() => {});
  }
  await sql.end();
});

describe("PATCH /crm/contacts/:id", () => {
  it("rejects an empty patch body", async () => {
    const app = await buildTestApp();
    const res = await app.inject({
      method: "PATCH",
      url: "/api/v1/crm/contacts/00000000-0000-0000-0000-000000000000",
      headers: json("crm-native-empty@test.com"),
      payload: {},
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("returns 404 for a contact that doesn't exist", async () => {
    const app = await buildTestApp();
    const res = await app.inject({
      method: "PATCH",
      url: "/api/v1/crm/contacts/00000000-0000-0000-0000-000000000000",
      headers: json("crm-native-404@test.com"),
      payload: { title: "New Title" },
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it("updates a contact's own field and does not leak across workspaces (cross-tenant isolation)", async () => {
    const app = await buildTestApp();

    const owner = await resolveOrProvisionUser(db, "stub:crm-native-owner@test.com", "crm-native-owner@test.com", "Owner");
    const [contact] = await db
      .insert(contacts)
      .values({ workspaceId: owner.workspaceId, firstName: "Ada" })
      .returning();
    seededContactIds.push(contact!.id);

    const patchRes = await app.inject({
      method: "PATCH",
      url: `/api/v1/crm/contacts/${contact!.id}`,
      headers: json("crm-native-owner@test.com"),
      payload: { title: "Engineer" },
    });
    expect(patchRes.statusCode).toBe(200);
    expect((patchRes.json() as { data: { title: string } }).data.title).toBe("Engineer");

    const crossTenantRes = await app.inject({
      method: "PATCH",
      url: `/api/v1/crm/contacts/${contact!.id}`,
      headers: json("crm-native-intruder@test.com"),
      payload: { title: "Hijacked" },
    });
    expect(crossTenantRes.statusCode).toBe(404);

    const [unchanged] = await db.select().from(contacts).where(eq(contacts.id, contact!.id));
    expect(unchanged?.title).toBe("Engineer");

    await app.close();
  });
});
