import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { createDb, type Db } from "./client.js";
import * as schema from "./schema/index.js";
import { resolveDatabaseUrl } from "./database-url.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
try {
  const { config } = await import("dotenv");
  config({ path: path.resolve(__dirname, "../../../.env") });
} catch {
  // optional
}

const hasDatabase = Boolean(process.env.DATABASE_URL || process.env.DATABASE_HOST);

describe.skipIf(!hasDatabase)("early access schema (0160)", () => {
  let db: Db;
  let sql: ReturnType<typeof createDb>["sql"];
  const suffix = Math.random().toString(36).slice(2, 10);

  beforeAll(() => {
    const created = createDb(resolveDatabaseUrl());
    db = created.db;
    sql = created.sql;
  });

  afterAll(async () => {
    await sql.end();
  });

  it("a workspace created without an access status is active", async () => {
    const [ws] = await db
      .insert(schema.workspaces)
      .values({ name: "Default access", slug: `ea-default-${suffix}` })
      .returning();
    expect(ws!.accessStatus).toBe("active");
    await db.delete(schema.workspaces).where(eq(schema.workspaces.id, ws!.id));
  });

  it("rejects an unknown access status", async () => {
    await expect(
      db.insert(schema.workspaces).values({ name: "Bad", slug: `ea-bad-${suffix}`, accessStatus: "bogus" as never })
    ).rejects.toThrow();
  });

  it("allows one access request per workspace", async () => {
    const [ws] = await db
      .insert(schema.workspaces)
      .values({ name: "Pending", slug: `ea-pending-${suffix}`, accessStatus: "pending" })
      .returning();
    const row = { workspaceId: ws!.id, email: `ea-${suffix}@test.com`, signupMethod: "password" as const };
    const [req] = await db.insert(schema.accessRequests).values(row).returning();
    expect(req!.status).toBe("pending");
    await expect(db.insert(schema.accessRequests).values(row)).rejects.toThrow();
    await db.delete(schema.workspaces).where(eq(schema.workspaces.id, ws!.id));
  });
});
