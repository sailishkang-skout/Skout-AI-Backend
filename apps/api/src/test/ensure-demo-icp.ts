import type { FastifyInstance } from "fastify";

const DEFAULT_TEST_ICP = {
  industries: ["Software & SaaS"],
  countries: ["US"],
  seniorities: ["vp", "director"],
  minEmployees: 10,
  autoRescoreOnChange: false,
};

/** Demo workspace needs ICP before enrich/score routes succeed. */
export async function ensureDemoIcp(app: FastifyInstance, workspaceId: string) {
  await app.inject({
    method: "PUT",
    url: "/api/v1/workspace/icp",
    headers: { "x-workspace-id": workspaceId, "content-type": "application/json" },
    payload: DEFAULT_TEST_ICP,
  });
}
