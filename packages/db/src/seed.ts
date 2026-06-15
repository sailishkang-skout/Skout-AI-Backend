import path from "node:path";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import { createDb } from "./client.js";
import { resolveDatabaseUrl } from "./database-url.js";
import { creditBalances } from "./schema/credits.js";
import { lists } from "./schema/prospects.js";
import { workspaces } from "./schema/workspaces.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Optional: load .env for local `pnpm db:seed` (dotenv is dev-only, not in ECS image).
try {
  const { config } = await import("dotenv");
  config({ path: path.resolve(__dirname, "../../../.env") });
} catch {
  // ECS/task inject DATABASE_HOST + DATABASE_PASSWORD directly.
}

const databaseUrl = resolveDatabaseUrl();

const DEMO_WORKSPACE_ID = "00000000-0000-4000-8000-000000000001";

const { db, sql } = createDb(databaseUrl);

try {
  const [existing] = await db
    .select({ id: workspaces.id })
    .from(workspaces)
    .where(eq(workspaces.id, DEMO_WORKSPACE_ID))
    .limit(1);

  if (!existing) {
    await db.insert(workspaces).values({
      id: DEMO_WORKSPACE_ID,
      name: "Demo Workspace",
      slug: "demo",
    });
    console.log("Created demo workspace");
  } else {
    console.log("Demo workspace already exists");
  }

  await db
    .insert(creditBalances)
    .values({ workspaceId: DEMO_WORKSPACE_ID, balance: 500 })
    .onConflictDoUpdate({
      target: creditBalances.workspaceId,
      set: { balance: 500 },
    });
  console.log("Seeded 500 credits");

  const [demoList] = await db
    .select({ id: lists.id })
    .from(lists)
    .where(eq(lists.workspaceId, DEMO_WORKSPACE_ID))
    .limit(1);

  if (!demoList) {
    await db.insert(lists).values({
      workspaceId: DEMO_WORKSPACE_ID,
      name: "My First List",
    });
    console.log("Created demo list");
  }

  console.log("Seed complete");
} finally {
  await sql.end();
}
