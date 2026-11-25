import type { FastifyInstance } from "fastify";

/**
 * Workbooks V2 (WB2-002). Everything under /api/v1/workbooks-v2 belongs to the `workbooks_v2` feature
 * switch, which is off unless COPS has switched it on for the workspace; the access guard answers 403
 * feature_disabled before any handler here runs, so no handler re-checks the flag.
 *
 * This is only the mount point: the workbook CRUD, rows and columns routes (WB2-011 onward) are
 * registered next to it and inherit the same guard. `status` is the one live route, and it lets a
 * client (and the tests) confirm the server, not the browser, is deciding who can reach V2.
 */
export async function workbookV2Routes(app: FastifyInstance) {
  app.get("/workbooks-v2/status", async (_request, reply) => reply.send({ data: { enabled: true } }));
}
