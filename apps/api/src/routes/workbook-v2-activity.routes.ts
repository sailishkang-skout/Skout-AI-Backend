import { Buffer } from "node:buffer";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { listWorkbookActivity, type ActivityCursor } from "../services/workbook-activity.service.js";
import { workbookRouteHelpers } from "./workbook-v2.common.js";

export const ACTIVITY_PAGE_DEFAULT = 25;
export const ACTIVITY_PAGE_MAX = 100;

const idParams = z.object({ id: z.string().uuid() });

const cursorShape = z.object({
  at: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/)
    // A date that does not exist (30 February) would fail in the database.
    .refine((at) => {
      const ms = Date.parse(`${at.slice(0, 23)}Z`);
      return !Number.isNaN(ms) && new Date(ms).toISOString() === `${at.slice(0, 23)}Z`;
    }),
  id: z.string().uuid(),
});

export const encodeActivityCursor = (cursor: ActivityCursor) => Buffer.from(JSON.stringify(cursor)).toString("base64url");

/** Opaque to the client: only what this route handed out is accepted. */
const cursor = z
  .string()
  .max(200)
  .transform((text, ctx) => {
    try {
      return cursorShape.parse(JSON.parse(Buffer.from(text, "base64url").toString("utf8")));
    } catch {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "not a cursor from this list" });
      return z.NEVER;
    }
  });

// Strict: a filter this route does not have is refused, not silently ignored.
const activityQuery = z
  .object({
    limit: z
      .string()
      .regex(/^\d{1,3}$/, "a whole number")
      .transform(Number)
      .pipe(z.number().int().min(1).max(ACTIVITY_PAGE_MAX))
      .optional(),
    cursor: cursor.optional(),
  })
  .strict();

/** A workbook's activity log (WB2-016), behind the same `workbooks_v2` switch and view permission as the workbook. */
export async function workbookV2ActivityRoutes(app: FastifyInstance) {
  const { authorize, handle } = workbookRouteHelpers(app);

  app.get(
    "/workbooks-v2/:id/activity",
    handle(async (request) => {
      const { db, actor } = await authorize(request, "enrichment:read");
      const { id } = idParams.parse(request.params);
      const query = activityQuery.parse(request.query ?? {});
      const page = await listWorkbookActivity(db, actor.workspaceId, id, { limit: query.limit ?? ACTIVITY_PAGE_DEFAULT, cursor: query.cursor });
      return { status: 200, body: { data: page.data, nextCursor: page.next ? encodeActivityCursor(page.next) : null } };
    })
  );
}
