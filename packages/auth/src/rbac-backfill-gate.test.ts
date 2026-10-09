import { describe, expect, it, vi } from "vitest";
import { schema } from "@skout/db";
import { assertRbacBackfillReady } from "./require-permission.js";

const { workspaceMemberRoles, workspaceMembers } = schema;

/** A fake Db whose `select().from(table).limit(1)` returns the rows configured for that table. */
function fakeDb(rows: { roles?: unknown[]; members?: unknown[] }) {
  const byTable = new Map<unknown, unknown[]>([
    [workspaceMemberRoles, rows.roles ?? []],
    [workspaceMembers, rows.members ?? []],
  ]);
  const queried: unknown[] = [];
  const db = {
    select: vi.fn().mockReturnValue({
      from: (table: unknown) => {
        queried.push(table);
        return { limit: async () => byTable.get(table) ?? [] };
      },
    }),
  };
  return { db, queried };
}

describe("assertRbacBackfillReady", () => {
  it("is ready as soon as any role grant exists, without looking at members", async () => {
    const { db, queried } = fakeDb({ roles: [{ userId: "u-1" }], members: [{ userId: "u-1" }] });
    const gate = await assertRbacBackfillReady(db as never);
    expect(gate).toEqual({ ready: true, sampleGrantExists: true, freshDatabase: false });
    expect(queried).toEqual([workspaceMemberRoles]);
  });

  it("is ready on a brand-new database: no grants and no members means nobody can be locked out", async () => {
    const { db } = fakeDb({ roles: [], members: [] });
    const gate = await assertRbacBackfillReady(db as never);
    expect(gate).toEqual({ ready: true, sampleGrantExists: false, freshDatabase: true });
  });

  it("still refuses when members exist but no role was ever granted (backfill not run)", async () => {
    const { db } = fakeDb({ roles: [], members: [{ userId: "u-1" }] });
    const gate = await assertRbacBackfillReady(db as never);
    expect(gate).toEqual({ ready: false, sampleGrantExists: false, freshDatabase: false });
  });
});
