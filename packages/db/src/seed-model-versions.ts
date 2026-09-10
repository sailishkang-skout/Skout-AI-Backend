/**
 * §5.1 / §6.1 — seed active ModelVersion + PromptVersion rows for AI pin paths.
 * Idempotent upserts. Run: pnpm --filter @skout/db seed-model-versions
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { and, eq } from "drizzle-orm";
import { createDb } from "./client.js";
import { resolveDatabaseUrl } from "./database-url.js";
import { modelVersions, promptVersions } from "./schema/model-versions.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
try {
  const { config } = await import("dotenv");
  config({ path: path.resolve(__dirname, "../../../.env") });
} catch {
  // ECS injects DATABASE_* directly
}

const LOGICAL_NAMES = [
  "score",
  "generate-email",
  "chat",
  "suggest-reply",
  "personalize",
  "sequence-generate",
] as const;

const databaseUrl = resolveDatabaseUrl();
const { db, sql } = createDb(databaseUrl);
const releasedAt = new Date("2026-08-24T00:00:00.000Z");

try {
  for (const name of LOGICAL_NAMES) {
    const versionLabel = `${name}-v1`;
    const [model] = await db
      .insert(modelVersions)
      .values({
        name,
        provider: "skout-platform",
        versionLabel,
        isActive: true,
        notes: `Seeded active pin target for ${name} (§5.1 / §6.1)`,
        releasedAt,
      })
      .onConflictDoUpdate({
        target: [modelVersions.name, modelVersions.versionLabel],
        set: {
          provider: "skout-platform",
          isActive: true,
          notes: `Seeded active pin target for ${name} (§5.1 / §6.1)`,
          releasedAt,
        },
      })
      .returning();

    if (!model) throw new Error(`Failed to upsert model_versions for ${name}`);

    const [existingPrompt] = await db
      .select()
      .from(promptVersions)
      .where(and(eq(promptVersions.name, name), eq(promptVersions.version, 1)))
      .limit(1);

    if (!existingPrompt) {
      await db.insert(promptVersions).values({
        name,
        version: 1,
        content: `platform-default:${name}`,
        modelVersionId: model.id,
        isActive: true,
      });
    } else {
      await db
        .update(promptVersions)
        .set({ isActive: false })
        .where(eq(promptVersions.name, name));
      await db
        .update(promptVersions)
        .set({
          isActive: true,
          content: `platform-default:${name}`,
          modelVersionId: model.id,
        })
        .where(and(eq(promptVersions.name, name), eq(promptVersions.version, 1)));
    }

    console.log(`seeded ${name} → model=${model.id}`);
  }
  console.log("Model/prompt version seed complete");
} finally {
  await sql.end();
}
