import type { FastifyInstance } from "fastify";
import { schema } from "@skout/db";

const DEFAULT_TEST_ICP = {
  industries: ["Software & SaaS"],
  countries: ["US"],
  seniorities: ["vp", "director"],
  minEmployees: 10,
  autoRescoreOnChange: false,
};

/** Demo workspace needs ICP before enrich/score routes succeed. */
export async function ensureDemoIcp(app: FastifyInstance, workspaceId: string) {
  if (!app.db) throw new Error("database_unavailable");
  await app.db
    .insert(schema.workspaceIcp)
    .values({ workspaceId, config: DEFAULT_TEST_ICP, version: 1 })
    .onConflictDoUpdate({
      target: schema.workspaceIcp.workspaceId,
      set: { config: DEFAULT_TEST_ICP, version: 1, updatedAt: new Date() },
    });
}
