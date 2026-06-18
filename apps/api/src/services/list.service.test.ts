import { describe, expect, it, vi } from "vitest";
import { ListService } from "./list.service.js";

// ---------------------------------------------------------------------------
// Mock builders
// ---------------------------------------------------------------------------

// select chain that terminates at the specified method
// getLists: ...where().groupBy().orderBy()  → resolves
// getListById: ...where().groupBy()         → resolves
// getMembers member query: ...where()       → resolves
function selectChain(result: unknown[], terminal: "orderBy" | "groupBy" | "where" = "where") {
  const c: Record<string, unknown> = {};
  c.from      = vi.fn().mockReturnValue(c);
  c.leftJoin  = vi.fn().mockReturnValue(c);
  c.where     = terminal === "where"    ? vi.fn().mockResolvedValue(result) : vi.fn().mockReturnValue(c);
  c.groupBy   = terminal === "groupBy"  ? vi.fn().mockResolvedValue(result) : vi.fn().mockReturnValue(c);
  c.orderBy   = terminal === "orderBy"  ? vi.fn().mockResolvedValue(result) : vi.fn().mockReturnValue(c);
  return c;
}

function insertReturning(result: unknown[]) {
  return { values: vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue(result) }) };
}

function insertOnConflictUpdate() {
  return {
    values: vi.fn().mockReturnValue({
      onConflictDoUpdate: vi.fn().mockResolvedValue([]),
    }),
  };
}

function insertOnConflictNothing() {
  return {
    values: vi.fn().mockReturnValue({
      onConflictDoNothing: vi.fn().mockResolvedValue([]),
    }),
  };
}

const LIST_ROW = {
  id: "list-1",
  workspaceId: "ws-1",
  name: "Test List",
  createdAt: new Date("2026-01-01T00:00:00Z"),
  memberCount: 0,
};

const MEMBER_ROW = {
  prospectId: "p-1",
  addedAt: new Date("2026-01-02T00:00:00Z"),
  companyId: "co-1",
  snapshot: { prospectId: "p-1", fullName: "Alice" },
};

function makeDb(selectResults: { result: unknown[]; terminal?: "orderBy" | "groupBy" | "where" }[], inserts: (() => unknown)[] = []) {
  const db = { select: vi.fn(), insert: vi.fn() };
  for (const { result, terminal } of selectResults) {
    db.select.mockReturnValueOnce(selectChain(result, terminal));
  }
  for (const factory of inserts) {
    db.insert.mockReturnValueOnce(factory());
  }
  return db;
}

// ---------------------------------------------------------------------------
// createList
// ---------------------------------------------------------------------------

describe("ListService.createList", () => {
  it("inserts a list and returns the shape with prospectCount 0", async () => {
    const db = makeDb([], [() => insertReturning([{ id: "list-1", name: "New List", createdAt: new Date("2026-01-01") }])]);
    const svc = new ListService(db as any, null);

    const result = await svc.createList("ws-1", "New List");

    expect(result.id).toBe("list-1");
    expect(result.name).toBe("New List");
    expect(result.workspaceId).toBe("ws-1");
    expect(result.prospectCount).toBe(0);
    expect(result.createdAt).toBe("2026-01-01T00:00:00.000Z");
  });

  it("calls db.insert once", async () => {
    const db = makeDb([], [() => insertReturning([{ id: "x", name: "L", createdAt: new Date() }])]);
    const svc = new ListService(db as any, null);
    await svc.createList("ws-1", "L");
    expect(db.insert).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// getLists
// ---------------------------------------------------------------------------

describe("ListService.getLists", () => {
  it("returns empty array when workspace has no lists", async () => {
    const db = makeDb([{ result: [], terminal: "orderBy" }]);
    const svc = new ListService(db as any, null);
    expect(await svc.getLists("ws-1")).toEqual([]);
  });

  it("maps rows to ProspectList shape", async () => {
    const db = makeDb([{ result: [LIST_ROW], terminal: "orderBy" }]);
    const svc = new ListService(db as any, null);

    const [list] = await svc.getLists("ws-1");
    expect(list.id).toBe("list-1");
    expect(list.name).toBe("Test List");
    expect(list.prospectCount).toBe(0);
    expect(list.createdAt).toBe("2026-01-01T00:00:00.000Z");
  });

  it("returns multiple lists", async () => {
    const rows = [
      { ...LIST_ROW, id: "l1", memberCount: 2 },
      { ...LIST_ROW, id: "l2", memberCount: 5 },
    ];
    const db = makeDb([{ result: rows, terminal: "orderBy" }]);
    const svc = new ListService(db as any, null);

    const lists = await svc.getLists("ws-1");
    expect(lists).toHaveLength(2);
    expect(lists[0].prospectCount).toBe(2);
    expect(lists[1].prospectCount).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// getListById
// ---------------------------------------------------------------------------

describe("ListService.getListById", () => {
  it("returns null when list not found", async () => {
    const db = makeDb([{ result: [], terminal: "groupBy" }]);
    const svc = new ListService(db as any, null);
    expect(await svc.getListById("ws-1", "missing")).toBeNull();
  });

  it("returns the list when found", async () => {
    const db = makeDb([{ result: [{ ...LIST_ROW, memberCount: 3 }], terminal: "groupBy" }]);
    const svc = new ListService(db as any, null);

    const list = await svc.getListById("ws-1", "list-1");
    expect(list).not.toBeNull();
    expect(list!.id).toBe("list-1");
    expect(list!.prospectCount).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// getMembers
// ---------------------------------------------------------------------------

describe("ListService.getMembers", () => {
  it("returns null when the list does not exist", async () => {
    const db = makeDb([{ result: [], terminal: "groupBy" }]);
    const svc = new ListService(db as any, null);
    expect(await svc.getMembers("ws-1", "missing")).toBeNull();
  });

  it("returns empty array when list exists but has no members", async () => {
    const db = makeDb([
      { result: [LIST_ROW], terminal: "groupBy" }, // getListById
      { result: [], terminal: "where" },             // member rows
    ]);
    const svc = new ListService(db as any, null);

    const members = await svc.getMembers("ws-1", "list-1");
    expect(members).toEqual([]);
  });

  it("returns members mapped to ProspectListMember shape", async () => {
    const db = makeDb([
      { result: [LIST_ROW], terminal: "groupBy" },
      { result: [MEMBER_ROW], terminal: "where" },
    ]);
    const svc = new ListService(db as any, null);

    const members = await svc.getMembers("ws-1", "list-1");
    expect(members).toHaveLength(1);
    expect(members![0]).toMatchObject({
      prospectId: "p-1",
      companyId: "co-1",
      snapshot: { prospectId: "p-1", fullName: "Alice" },
      addedAt: "2026-01-02T00:00:00.000Z",
    });
  });

  it("falls back companyId to prospectId when companyId is null", async () => {
    const rowWithNullCompany = { ...MEMBER_ROW, companyId: null };
    const db = makeDb([
      { result: [LIST_ROW], terminal: "groupBy" },
      { result: [rowWithNullCompany], terminal: "where" },
    ]);
    const svc = new ListService(db as any, null);

    const members = await svc.getMembers("ws-1", "list-1");
    expect(members![0].companyId).toBe("p-1");
  });

  it("defaults snapshot to empty object when null", async () => {
    const rowWithNullSnapshot = { ...MEMBER_ROW, snapshot: null };
    const db = makeDb([
      { result: [LIST_ROW], terminal: "groupBy" },
      { result: [rowWithNullSnapshot], terminal: "where" },
    ]);
    const svc = new ListService(db as any, null);

    const members = await svc.getMembers("ws-1", "list-1");
    expect(members![0].snapshot).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// addMembers
// ---------------------------------------------------------------------------

describe("ListService.addMembers", () => {
  it("returns null when the list does not exist", async () => {
    const db = makeDb([{ result: [], terminal: "groupBy" }]);
    const svc = new ListService(db as any, null);
    expect(await svc.addMembers("ws-1", "missing", ["p1"])).toBeNull();
  });

  it("returns the unchanged list when prospectIds is empty", async () => {
    const db = makeDb([{ result: [LIST_ROW], terminal: "groupBy" }]);
    const svc = new ListService(db as any, null);

    const result = await svc.addMembers("ws-1", "list-1", []);
    expect(result!.id).toBe("list-1");
    expect(db.insert).not.toHaveBeenCalled();
  });

  it("inserts one prospect_activation and one list_member per prospectId", async () => {
    const updatedList = { ...LIST_ROW, memberCount: 2 };
    const db = makeDb(
      [
        { result: [LIST_ROW], terminal: "groupBy" },  // initial getListById
        { result: [updatedList], terminal: "groupBy" }, // getListByIdWithMembers → getListById
        { result: [MEMBER_ROW, { ...MEMBER_ROW, prospectId: "p-2", addedAt: new Date() }], terminal: "where" }, // members
      ],
      [
        () => insertOnConflictUpdate(), // prospectActivations for p-1
        () => insertOnConflictUpdate(), // prospectActivations for p-2
        () => insertOnConflictNothing(), // listMembers
      ]
    );
    const svc = new ListService(db as any, null);

    const result = await svc.addMembers("ws-1", "list-1", ["p-1", "p-2"]);

    expect(result).not.toBeNull();
    expect(db.insert).toHaveBeenCalledTimes(3);
  });

  it("returns the list with members array after adding", async () => {
    const updatedList = { ...LIST_ROW, memberCount: 1 };
    const db = makeDb(
      [
        { result: [LIST_ROW], terminal: "groupBy" },
        { result: [updatedList], terminal: "groupBy" },
        { result: [MEMBER_ROW], terminal: "where" },
      ],
      [
        () => insertOnConflictUpdate(),
        () => insertOnConflictNothing(),
      ]
    );
    const svc = new ListService(db as any, null);

    const result = await svc.addMembers("ws-1", "list-1", ["p-1"]);
    expect(result!.members).toHaveLength(1);
    expect(result!.members![0].prospectId).toBe("p-1");
    expect(result!.prospectCount).toBe(1);
  });

  it("does not call OpenSearch when osCfg is null", async () => {
    const updatedList = { ...LIST_ROW, memberCount: 1 };
    const db = makeDb(
      [
        { result: [LIST_ROW], terminal: "groupBy" },
        { result: [updatedList], terminal: "groupBy" },
        { result: [MEMBER_ROW], terminal: "where" },
      ],
      [
        () => insertOnConflictUpdate(),
        () => insertOnConflictNothing(),
      ]
    );
    const svc = new ListService(db as any, null);

    // snapshot falls back to { prospectId } when no OS config
    const insertMock = insertOnConflictUpdate();
    const valuesFn = insertMock.values as ReturnType<typeof vi.fn>;

    await svc.addMembers("ws-1", "list-1", ["p-1"]);

    // The prospectActivation insert should use the fallback snapshot
    const firstInsertArg = (db.insert.mock.results[0].value as ReturnType<typeof insertOnConflictUpdate>);
    const valuesArg = (firstInsertArg as { values: ReturnType<typeof vi.fn> }).values.mock.calls[0][0];
    expect(valuesArg).toMatchObject({ prospectId: "p-1", snapshot: { prospectId: "p-1" } });
  });
});

// ---------------------------------------------------------------------------
// buildListService factory
// ---------------------------------------------------------------------------

describe("buildListService", () => {
  it("returns null when db is null", async () => {
    const { buildListService } = await import("./list.service.js");
    expect(buildListService(null, null)).toBeNull();
  });

  it("returns a ListService instance when db is provided", async () => {
    const { buildListService } = await import("./list.service.js");
    const db = makeDb([], []);
    const svc = buildListService(db as any, null);
    expect(svc).toBeInstanceOf(ListService);
  });
});
