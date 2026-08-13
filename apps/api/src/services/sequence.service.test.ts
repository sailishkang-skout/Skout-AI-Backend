import { describe, expect, it, vi } from "vitest";
import { SequenceService, buildSequenceService, SEQUENCE_STATUSES, STEP_TYPES, SEQUENCE_MODES, CONDITION_TYPES } from "./sequence.service.js";
import { HttpError } from "../utils/http.js";

// ---------------------------------------------------------------------------
// Mock chain builders
// ---------------------------------------------------------------------------

type Terminal = "orderBy" | "where";

function selectChain(result: unknown[], terminal: Terminal = "where") {
  const c = {} as Record<string, ReturnType<typeof vi.fn>>;
  c.from = vi.fn().mockReturnValue(c);
  if (terminal === "where") {
    c.where = vi.fn().mockResolvedValue(result);
    c.orderBy = vi.fn().mockReturnValue(c);
  } else {
    c.where = vi.fn().mockReturnValue(c);
    const afterOrder = {
      limit: vi.fn().mockResolvedValue(result),
      then: (onFulfilled: (v: unknown) => unknown, onRejected?: (e: unknown) => unknown) =>
        Promise.resolve(result).then(onFulfilled, onRejected),
    };
    c.orderBy = vi.fn().mockReturnValue(afterOrder);
  }
  return c;
}

/** Chain that passes through all join/group/order calls, resolving at orderBy. */
function joinChain(result: unknown[]) {
  const c = {} as Record<string, ReturnType<typeof vi.fn>>;
  const pass = () => c;
  c.from       = vi.fn().mockReturnValue(c);
  c.innerJoin  = vi.fn().mockReturnValue(c);
  c.leftJoin   = vi.fn().mockReturnValue(c);
  c.where      = vi.fn().mockReturnValue(c);
  c.groupBy    = vi.fn().mockReturnValue(c);
  c.orderBy    = vi.fn().mockResolvedValue(result);
  return c;
}

function insertReturning(result: unknown[]) {
  return {
    values: vi.fn().mockReturnValue({
      returning: vi.fn().mockResolvedValue(result),
      onConflictDoNothing: vi.fn().mockResolvedValue(result),
    }),
  };
}

function updateReturning(result: unknown[]) {
  return {
    set: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue(result) }),
    }),
  };
}

function updateWhere() {
  return { set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue([]) }) };
}

function deleteWhere() {
  return { where: vi.fn().mockResolvedValue([]) };
}

function makeTx() {
  const whereResolved = vi.fn().mockResolvedValue([]);
  const setChain = { where: whereResolved };
  const setFn = vi.fn().mockReturnValue(setChain);
  return { update: vi.fn().mockReturnValue({ set: setFn }) };
}

interface DbSpec {
  selects?: { result: unknown[]; terminal?: Terminal }[];
  inserts?: (() => unknown)[];
  updates?: (() => unknown)[];
  deletes?: (() => unknown)[];
  transaction?: (callback: (tx: unknown) => Promise<unknown>) => Promise<unknown>;
}

function makeDb(spec: DbSpec = {}) {
  const db: Record<string, ReturnType<typeof vi.fn>> = {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  };
  if (spec.transaction) db.transaction = vi.fn().mockImplementation(spec.transaction);
  for (const { result, terminal } of spec.selects ?? []) {
    db.select!.mockReturnValueOnce(selectChain(result, terminal));
  }
  for (const factory of spec.inserts ?? []) {
    db.insert!.mockReturnValueOnce(factory());
  }
  for (const factory of spec.updates ?? []) {
    db.update!.mockReturnValueOnce(factory());
  }
  for (const factory of spec.deletes ?? []) {
    db.delete!.mockReturnValueOnce(factory());
  }
  return db;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SEQ_ROW = {
  id: "seq-1",
  workspaceId: "ws-1",
  name: "My Sequence",
  status: "draft",
  createdAt: new Date("2026-01-01T00:00:00Z"),
  updatedAt: new Date("2026-01-01T00:00:00Z"),
};

const STEP_ROW = {
  id: "step-1",
  sequenceId: "seq-1",
  stepOrder: 1,
  stepType: "email",
  delayDays: 0,
  subject: "Hello {{firstName}}",
  bodyTemplate: "Hi {{firstName}}, welcome to {{companyName}}!",
  createdAt: new Date("2026-01-01T00:00:00Z"),
};

// ---------------------------------------------------------------------------
// listSequences
// ---------------------------------------------------------------------------

describe("SequenceService.listSequences", () => {
  it("returns empty array for a workspace with no sequences", async () => {
    const db = makeDb({ selects: [{ result: [], terminal: "orderBy" }] });
    const svc = new SequenceService(db as any);
    expect(await svc.listSequences("ws-1")).toEqual([]);
  });

  it("returns rows when sequences exist", async () => {
    const db = makeDb({ selects: [{ result: [SEQ_ROW, { ...SEQ_ROW, id: "seq-2" }], terminal: "orderBy" }] });
    const svc = new SequenceService(db as any);
    const result = await svc.listSequences("ws-1");
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({ id: "seq-1", name: "My Sequence" });
  });

  it("calls db.select once", async () => {
    const db = makeDb({ selects: [{ result: [], terminal: "orderBy" }] });
    const svc = new SequenceService(db as any);
    await svc.listSequences("ws-1");
    expect(db.select).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// createSequence
// ---------------------------------------------------------------------------

describe("SequenceService.createSequence", () => {
  it("inserts and returns the new sequence", async () => {
    const db = makeDb({ inserts: [() => insertReturning([SEQ_ROW])] });
    const svc = new SequenceService(db as any);
    const result = await svc.createSequence("ws-1", "My Sequence");
    expect(result).toMatchObject({ id: "seq-1", name: "My Sequence", status: "draft" });
  });

  it("calls db.insert once", async () => {
    const db = makeDb({ inserts: [() => insertReturning([SEQ_ROW])] });
    const svc = new SequenceService(db as any);
    await svc.createSequence("ws-1", "My Sequence");
    expect(db.insert).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// getSequenceById
// ---------------------------------------------------------------------------

describe("SequenceService.getSequenceById", () => {
  it("returns null when sequence not found", async () => {
    const db = makeDb({ selects: [{ result: [], terminal: "where" }] });
    const svc = new SequenceService(db as any);
    expect(await svc.getSequenceById("ws-1", "missing")).toBeNull();
  });

  it("returns sequence with steps sorted by stepOrder", async () => {
    const step2 = { ...STEP_ROW, id: "step-2", stepOrder: 2, stepType: "wait" };
    const db = makeDb({
      selects: [
        { result: [SEQ_ROW], terminal: "where" },
        { result: [STEP_ROW, step2], terminal: "orderBy" },
        { result: [], terminal: "where" },
      ],
    });
    const svc = new SequenceService(db as any);
    const result = await svc.getSequenceById("ws-1", "seq-1");
    expect(result).not.toBeNull();
    expect(result!.id).toBe("seq-1");
    expect(result!.steps).toHaveLength(2);
    expect(result!.steps[0]).toMatchObject({ id: "step-1", stepOrder: 1 });
    expect(result!.steps[1]).toMatchObject({ id: "step-2", stepOrder: 2 });
  });

  it("returns sequence with empty steps array when no steps exist", async () => {
    const db = makeDb({
      selects: [
        { result: [SEQ_ROW], terminal: "where" },
        { result: [], terminal: "orderBy" },
      ],
    });
    const svc = new SequenceService(db as any);
    const result = await svc.getSequenceById("ws-1", "seq-1");
    expect(result!.steps).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// updateSequence
// ---------------------------------------------------------------------------

describe("SequenceService.updateSequence", () => {
  it("returns null when sequence not found", async () => {
    const db = makeDb({ selects: [{ result: [], terminal: "where" }] });
    const svc = new SequenceService(db as any);
    expect(await svc.updateSequence("ws-1", "missing", { name: "New Name" })).toBeNull();
  });

  it("updates the name and returns the updated row", async () => {
    const updated = { ...SEQ_ROW, name: "Renamed" };
    const db = makeDb({
      selects: [{ result: [SEQ_ROW], terminal: "where" }],
      updates: [() => updateReturning([updated])],
    });
    const svc = new SequenceService(db as any);
    const result = await svc.updateSequence("ws-1", "seq-1", { name: "Renamed" });
    expect(result!.name).toBe("Renamed");
  });

  it("allows draft → active transition", async () => {
    const updated = { ...SEQ_ROW, status: "active" };
    const db = makeDb({
      selects: [
        { result: [{ ...SEQ_ROW, status: "draft" }], terminal: "where" },
        { result: [], terminal: "orderBy" },
        { result: [{ ...SEQ_ROW, status: "active", currentVersion: 0 }], terminal: "where" },
        { result: [], terminal: "orderBy" },
      ],
      inserts: [() => insertReturning([{ id: "ver-1", version: 1, status: "published" }])],
      updates: [() => updateReturning([updated]), () => updateWhere()],
    });
    const svc = new SequenceService(db as any);
    const result = await svc.updateSequence("ws-1", "seq-1", { status: "active" });
    expect(result!.status).toBe("active");
  });

  it("allows active → paused transition", async () => {
    const updated = { ...SEQ_ROW, status: "paused" };
    const db = makeDb({
      selects: [{ result: [{ ...SEQ_ROW, status: "active" }], terminal: "where" }],
      updates: [() => updateReturning([updated])],
    });
    const svc = new SequenceService(db as any);
    const result = await svc.updateSequence("ws-1", "seq-1", { status: "paused" });
    expect(result!.status).toBe("paused");
  });

  it("allows paused → active transition (resume)", async () => {
    const updated = { ...SEQ_ROW, status: "active" };
    const db = makeDb({
      selects: [
        { result: [{ ...SEQ_ROW, status: "paused" }], terminal: "where" },
        { result: [], terminal: "orderBy" },
      ],
      updates: [() => updateReturning([updated])],
    });
    const svc = new SequenceService(db as any);
    const result = await svc.updateSequence("ws-1", "seq-1", { status: "active" });
    expect(result!.status).toBe("active");
  });

  it("allows active → archived transition", async () => {
    const updated = { ...SEQ_ROW, status: "archived" };
    const db = makeDb({
      selects: [{ result: [{ ...SEQ_ROW, status: "active" }], terminal: "where" }],
      updates: [() => updateReturning([updated])],
    });
    const svc = new SequenceService(db as any);
    const result = await svc.updateSequence("ws-1", "seq-1", { status: "archived" });
    expect(result!.status).toBe("archived");
  });

  it("throws HttpError 422 for invalid transition draft → paused", async () => {
    const db = makeDb({
      selects: [{ result: [{ ...SEQ_ROW, status: "draft" }], terminal: "where" }],
    });
    const svc = new SequenceService(db as any);
    await expect(svc.updateSequence("ws-1", "seq-1", { status: "paused" })).rejects.toMatchObject({
      statusCode: 422,
    });
  });

  it("throws HttpError 422 for invalid transition archived → active", async () => {
    const db = makeDb({
      selects: [
        { result: [{ ...SEQ_ROW, status: "archived" }], terminal: "where" },
        { result: [{ ...SEQ_ROW, status: "archived" }], terminal: "where" },
      ],
    });
    const svc = new SequenceService(db as any);
    await expect(svc.updateSequence("ws-1", "seq-1", { status: "active" })).rejects.toMatchObject({
      statusCode: 422,
    });
  });

  it("throws HttpError 422 for an unrecognized status value", async () => {
    const db = makeDb({ selects: [{ result: [SEQ_ROW], terminal: "where" }] });
    const svc = new SequenceService(db as any);
    await expect(svc.updateSequence("ws-1", "seq-1", { status: "unknown_status" })).rejects.toMatchObject({
      statusCode: 422,
    });
  });
});

// ---------------------------------------------------------------------------
// deleteSequence
// ---------------------------------------------------------------------------

describe("SequenceService.deleteSequence", () => {
  it("calls db.delete once", async () => {
    const db = makeDb({ deletes: [() => deleteWhere()] });
    const svc = new SequenceService(db as any);
    await svc.deleteSequence("ws-1", "seq-1");
    expect(db.delete).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// addStep
// ---------------------------------------------------------------------------

describe("SequenceService.addStep", () => {
  it("returns null when sequence not found", async () => {
    const db = makeDb({ selects: [{ result: [], terminal: "where" }] });
    const svc = new SequenceService(db as any);
    expect(await svc.addStep("ws-1", "missing", { stepType: "email", delayDays: 0 })).toBeNull();
  });

  it("appends step at next order position", async () => {
    const newStep = { ...STEP_ROW, id: "step-2", stepOrder: 2, stepType: "wait" };
    const db = makeDb({
      selects: [
        { result: [SEQ_ROW], terminal: "where" },
        { result: [{ stepOrder: 1 }], terminal: "orderBy" }, // one existing step
      ],
      inserts: [() => insertReturning([newStep])],
    });
    const svc = new SequenceService(db as any);
    const result = await svc.addStep("ws-1", "seq-1", { stepType: "wait", delayDays: 2 });
    expect(result!.id).toBe("step-2");
    expect(result!.stepOrder).toBe(2);
  });

  it("assigns stepOrder 1 when no existing steps", async () => {
    const db = makeDb({
      selects: [
        { result: [SEQ_ROW], terminal: "where" },
        { result: [], terminal: "orderBy" },
      ],
      inserts: [() => insertReturning([STEP_ROW]), () => insertReturning([])],
    });
    const svc = new SequenceService(db as any);
    const result = await svc.addStep("ws-1", "seq-1", { stepType: "email", delayDays: 0 });
    expect(result!.stepOrder).toBe(1);
  });

  it("throws HttpError 422 for an unknown merge token in bodyTemplate", async () => {
    const db = makeDb({ selects: [{ result: [SEQ_ROW], terminal: "where" }] });
    const svc = new SequenceService(db as any);
    await expect(
      svc.addStep("ws-1", "seq-1", { stepType: "email", delayDays: 0, bodyTemplate: "Hello {{badToken}}!" })
    ).rejects.toMatchObject({ statusCode: 422 });
  });

  it("accepts all valid merge tokens in bodyTemplate", async () => {
    const template = "Hi {{firstName}} {{lastName}}, from {{companyName}} ({{companyDomain}}). Your title is {{title}}.";
    const db = makeDb({
      selects: [
        { result: [SEQ_ROW], terminal: "where" },
        { result: [], terminal: "orderBy" },
      ],
      inserts: [() => insertReturning([{ ...STEP_ROW, bodyTemplate: template }]), () => insertReturning([])],
    });
    const svc = new SequenceService(db as any);
    const result = await svc.addStep("ws-1", "seq-1", { stepType: "email", delayDays: 0, bodyTemplate: template });
    expect(result!.bodyTemplate).toBe(template);
  });

  it("accepts all sender and utility merge tokens", async () => {
    const template = "Sent by {{senderName}} <{{senderEmail}}>. {{unsubscribeUrl}}";
    const db = makeDb({
      selects: [
        { result: [SEQ_ROW], terminal: "where" },
        { result: [], terminal: "orderBy" },
      ],
      inserts: [() => insertReturning([{ ...STEP_ROW, bodyTemplate: template }]), () => insertReturning([])],
    });
    const svc = new SequenceService(db as any);
    await expect(
      svc.addStep("ws-1", "seq-1", { stepType: "email", delayDays: 0, bodyTemplate: template })
    ).resolves.not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// updateStep
// ---------------------------------------------------------------------------

describe("SequenceService.updateStep", () => {
  it("returns null when sequence not found", async () => {
    const db = makeDb({ selects: [{ result: [], terminal: "where" }] });
    const svc = new SequenceService(db as any);
    expect(await svc.updateStep("ws-1", "missing", "step-1", { delayDays: 3 })).toBeNull();
  });

  it("returns null when step not found", async () => {
    const db = makeDb({
      selects: [{ result: [SEQ_ROW], terminal: "where" }],
      updates: [() => updateReturning([])],
    });
    const svc = new SequenceService(db as any);
    expect(await svc.updateStep("ws-1", "seq-1", "missing-step", { delayDays: 3 })).toBeNull();
  });

  it("updates step fields and returns updated row", async () => {
    const updated = { ...STEP_ROW, delayDays: 5, subject: "Updated subject" };
    const db = makeDb({
      selects: [{ result: [SEQ_ROW], terminal: "where" }],
      updates: [() => updateReturning([updated])],
    });
    const svc = new SequenceService(db as any);
    const result = await svc.updateStep("ws-1", "seq-1", "step-1", { delayDays: 5, subject: "Updated subject" });
    expect(result!.delayDays).toBe(5);
    expect(result!.subject).toBe("Updated subject");
  });

  it("throws HttpError 422 for unknown merge token in bodyTemplate update", async () => {
    const db = makeDb({ selects: [{ result: [SEQ_ROW], terminal: "where" }] });
    const svc = new SequenceService(db as any);
    await expect(
      svc.updateStep("ws-1", "seq-1", "step-1", { bodyTemplate: "Hello {{invalidToken}}" })
    ).rejects.toMatchObject({ statusCode: 422 });
  });

  it("allows clearing subject and bodyTemplate with null", async () => {
    const updated = { ...STEP_ROW, subject: null, bodyTemplate: null };
    const db = makeDb({
      selects: [{ result: [SEQ_ROW], terminal: "where" }],
      updates: [() => updateReturning([updated])],
    });
    const svc = new SequenceService(db as any);
    const result = await svc.updateStep("ws-1", "seq-1", "step-1", { subject: null, bodyTemplate: null });
    expect(result!.subject).toBeNull();
    expect(result!.bodyTemplate).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// deleteStep
// ---------------------------------------------------------------------------

describe("SequenceService.deleteStep", () => {
  it("returns false when sequence not found", async () => {
    const db = makeDb({ selects: [{ result: [], terminal: "where" }] });
    const svc = new SequenceService(db as any);
    expect(await svc.deleteStep("ws-1", "missing", "step-1")).toBe(false);
  });

  it("returns true and does not call update when last step deleted", async () => {
    const db = makeDb({
      selects: [
        { result: [SEQ_ROW], terminal: "where" },
        { result: [], terminal: "orderBy" }, // remaining after delete = empty
      ],
      deletes: [() => deleteWhere()],
    });
    const svc = new SequenceService(db as any);
    const result = await svc.deleteStep("ws-1", "seq-1", "step-1");
    expect(result).toBe(true);
    expect(db.update).not.toHaveBeenCalled();
  });

  it("renumbers remaining steps after a middle step is deleted", async () => {
    // Two remaining steps where the first already has stepOrder 1 (correct)
    // and the second has stepOrder 3 (must become 2)
    const remaining = [
      { id: "step-1", stepOrder: 1 },
      { id: "step-3", stepOrder: 3 },
    ];
    const db = makeDb({
      selects: [
        { result: [SEQ_ROW], terminal: "where" },
        { result: remaining, terminal: "orderBy" },
      ],
      deletes: [() => deleteWhere()],
      updates: [() => updateWhere()], // one renumber update for step-3 → stepOrder 2
    });
    const svc = new SequenceService(db as any);
    await svc.deleteStep("ws-1", "seq-1", "step-2");
    // Only step-3 needed renumbering
    expect(db.update).toHaveBeenCalledTimes(1);
  });

  it("does not renumber steps that already have correct order", async () => {
    const remaining = [{ id: "step-1", stepOrder: 1 }];
    const db = makeDb({
      selects: [
        { result: [SEQ_ROW], terminal: "where" },
        { result: remaining, terminal: "orderBy" },
      ],
      deletes: [() => deleteWhere()],
    });
    const svc = new SequenceService(db as any);
    await svc.deleteStep("ws-1", "seq-1", "step-2");
    expect(db.update).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// reorderSteps
// ---------------------------------------------------------------------------

describe("SequenceService.reorderSteps", () => {
  it("returns null when sequence not found", async () => {
    const db = makeDb({ selects: [{ result: [], terminal: "where" }] });
    const svc = new SequenceService(db as any);
    expect(await svc.reorderSteps("ws-1", "missing", ["step-1"])).toBeNull();
  });

  it("throws HttpError 422 when orderedStepIds count does not match existing steps", async () => {
    const db = makeDb({
      selects: [
        { result: [SEQ_ROW], terminal: "where" },
        { result: [STEP_ROW, { ...STEP_ROW, id: "step-2" }], terminal: "where" },
      ],
    });
    const svc = new SequenceService(db as any);
    await expect(svc.reorderSteps("ws-1", "seq-1", ["step-1"])).rejects.toMatchObject({ statusCode: 422 });
  });

  it("throws HttpError 422 when a step ID does not belong to the sequence", async () => {
    const db = makeDb({
      selects: [
        { result: [SEQ_ROW], terminal: "where" },
        { result: [STEP_ROW], terminal: "where" },
      ],
    });
    const svc = new SequenceService(db as any);
    await expect(svc.reorderSteps("ws-1", "seq-1", ["foreign-step-id"])).rejects.toMatchObject({ statusCode: 422 });
  });

  it("runs transaction and returns steps in new order", async () => {
    const step1 = { ...STEP_ROW, id: "step-1", stepOrder: 1 };
    const step2 = { ...STEP_ROW, id: "step-2", stepOrder: 2 };
    const reordered = [{ ...step2, stepOrder: 1 }, { ...step1, stepOrder: 2 }];
    const tx = makeTx();
    const db = makeDb({
      selects: [
        { result: [SEQ_ROW], terminal: "where" },
        { result: [step1, step2], terminal: "where" },
        { result: reordered, terminal: "orderBy" }, // final select after transaction
      ],
      transaction: async (cb) => cb(tx),
    });
    const svc = new SequenceService(db as any);
    const result = await svc.reorderSteps("ws-1", "seq-1", ["step-2", "step-1"]);
    expect(result).toHaveLength(2);
    expect(result![0]).toMatchObject({ id: "step-2", stepOrder: 1 });
    expect(result![1]).toMatchObject({ id: "step-1", stepOrder: 2 });
    // Transaction update called 4 times: 2 steps × 2 passes
    expect(tx.update).toHaveBeenCalledTimes(4);
  });
});

// ---------------------------------------------------------------------------
// enroll
// ---------------------------------------------------------------------------

const ACTIVE_SEQ = { ...SEQ_ROW, status: "active" };
const ENROLLMENT_ROW = {
  id: "enroll-1",
  workspaceId: "ws-1",
  sequenceId: "seq-1",
  prospectId: "p-1",
  listId: null,
  status: "active",
  enrolledAt: new Date("2026-01-01T09:00:00Z"),
  completedAt: null,
};

function insertOnConflictReturning(result: unknown[]) {
  const returning = vi.fn().mockResolvedValue(result);
  const onConflict = vi.fn().mockReturnValue({ returning });
  return { values: vi.fn().mockReturnValue({ onConflictDoNothing: onConflict }) };
}

function insertOnConflict() {
  const onConflict = vi.fn().mockResolvedValue(undefined);
  return { values: vi.fn().mockReturnValue({ onConflictDoNothing: onConflict }) };
}

describe("SequenceService.enroll", () => {
  it("throws HttpError 404 when sequence not found", async () => {
    const db = makeDb({ selects: [{ result: [], terminal: "where" }] });
    const svc = new SequenceService(db as any);
    await expect(
      svc.enroll("seq-1", "ws-1", { prospectIds: ["p-1"] })
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it("throws HttpError 422 when sequence is not active", async () => {
    const db = makeDb({ selects: [{ result: [SEQ_ROW], terminal: "where" }] });
    const svc = new SequenceService(db as any);
    await expect(
      svc.enroll("seq-1", "ws-1", { prospectIds: ["p-1"] })
    ).rejects.toMatchObject({ statusCode: 422 });
  });

  it("throws HttpError 422 when sequence has no steps", async () => {
    const db = makeDb({
      selects: [
        { result: [ACTIVE_SEQ], terminal: "where" },
        { result: [], terminal: "orderBy" },
      ],
    });
    const svc = new SequenceService(db as any);
    await expect(
      svc.enroll("seq-1", "ws-1", { prospectIds: ["p-1"] })
    ).rejects.toMatchObject({ statusCode: 422 });
  });

  it("enrolls a single prospect and returns enrolled=1 skipped=0", async () => {
    const db = makeDb({
      selects: [
        { result: [ACTIVE_SEQ], terminal: "where" },
        { result: [STEP_ROW], terminal: "orderBy" },
        { result: [], terminal: "orderBy" },
      ],
      deletes: [() => deleteWhere()],
      inserts: [
        () => insertOnConflictReturning([ENROLLMENT_ROW]),
        () => insertOnConflict(),
      ],
    });
    const svc = new SequenceService(db as any);
    const result = await svc.enroll("seq-1", "ws-1", { prospectIds: ["p-1"] });
    expect(result.enrolled).toBe(1);
    expect(result.skipped).toBe(0);
    expect(result.total).toBe(1);
    expect(result.newEnrollments).toHaveLength(1);
    expect(result.newEnrollments[0]).toMatchObject({
      enrollmentId: "enroll-1",
      prospectId: "p-1",
    });
  });

  it("skips duplicate enrollment and returns skipped=1", async () => {
    const db = makeDb({
      selects: [
        { result: [ACTIVE_SEQ], terminal: "where" },
        { result: [STEP_ROW], terminal: "orderBy" },
        { result: [], terminal: "orderBy" },
      ],
      deletes: [() => deleteWhere()],
      inserts: [
        () => insertOnConflictReturning([]),
      ],
    });
    const svc = new SequenceService(db as any);
    const result = await svc.enroll("seq-1", "ws-1", { prospectIds: ["p-1"] });
    expect(result.enrolled).toBe(0);
    expect(result.skipped).toBe(1);
    expect(result.total).toBe(1);
    expect(result.newEnrollments).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// listEnrolledLists
// ---------------------------------------------------------------------------

describe("SequenceService.listEnrolledLists", () => {
  it("returns null when sequence is not found", async () => {
    const db = {
      select: vi.fn().mockReturnValueOnce(selectChain([])),
    };
    const svc = new SequenceService(db as any);
    const result = await svc.listEnrolledLists("ws-1", "seq-missing");
    expect(result).toBeNull();
  });

  it("returns empty array when no members are enrolled", async () => {
    const db = {
      select: vi.fn()
        .mockReturnValueOnce(selectChain([SEQ_ROW]))
        .mockReturnValueOnce(joinChain([])),
    };
    const svc = new SequenceService(db as any);
    const result = await svc.listEnrolledLists("ws-1", "seq-1");
    expect(result).toEqual([]);
  });

  it("returns lists for enrollments made via listId", async () => {
    const db = {
      select: vi.fn()
        .mockReturnValueOnce(selectChain([SEQ_ROW]))
        .mockReturnValueOnce(joinChain([
          { listId: "list-1", listName: "Campaign A", total: 2, active: 1, completed: 1, enrolledAt: "2026-07-01" },
        ])),
    };
    const svc = new SequenceService(db as any);
    const result = await svc.listEnrolledLists("ws-1", "seq-1");
    expect(result).toHaveLength(1);
    expect(result![0]).toMatchObject({ listId: "list-1", listName: "Campaign A", total: 2, active: 1, completed: 1 });
  });

  it("returns lists for enrollments made via prospectIds (member-selected)", async () => {
    const db = {
      select: vi.fn()
        .mockReturnValueOnce(selectChain([SEQ_ROW]))
        .mockReturnValueOnce(joinChain([
          { listId: "list-2", listName: "Data", total: 1, active: 0, completed: 1, enrolledAt: "2026-07-10" },
        ])),
    };
    const svc = new SequenceService(db as any);
    const result = await svc.listEnrolledLists("ws-1", "seq-1");
    expect(result).toHaveLength(1);
    expect(result![0]).toMatchObject({ listId: "list-2", listName: "Data", total: 1, completed: 1 });
  });

  it("falls back to 'Deleted list' when list name is null", async () => {
    const db = {
      select: vi.fn()
        .mockReturnValueOnce(selectChain([SEQ_ROW]))
        .mockReturnValueOnce(joinChain([
          { listId: "list-orphan", listName: null, total: 1, active: 0, completed: 1, enrolledAt: "2026-07-10" },
        ])),
    };
    const svc = new SequenceService(db as any);
    const result = await svc.listEnrolledLists("ws-1", "seq-1");
    expect(result![0]!.listName).toBe("Deleted list");
  });
});

// ---------------------------------------------------------------------------
// listSequencesForList
// ---------------------------------------------------------------------------

describe("SequenceService.listSequencesForList", () => {
  it("returns null when list is not found", async () => {
    const db = {
      select: vi.fn().mockReturnValueOnce(selectChain([])),
    };
    const svc = new SequenceService(db as any);
    const result = await svc.listSequencesForList("ws-1", "list-missing");
    expect(result).toBeNull();
  });

  it("returns empty array when list has no members", async () => {
    const db = {
      select: vi.fn()
        .mockReturnValueOnce(selectChain([{ id: "list-1" }]))
        .mockReturnValueOnce(selectChain([]))          // no members
        .mockReturnValueOnce(joinChain([])),            // no sequence rows
    };
    const svc = new SequenceService(db as any);
    const result = await svc.listSequencesForList("ws-1", "list-1");
    expect(result).toEqual([]);
  });

  it("returns sequences for list-enrolled members", async () => {
    const db = {
      select: vi.fn()
        .mockReturnValueOnce(selectChain([{ id: "list-1" }]))
        .mockReturnValueOnce(selectChain([{ prospectId: "p-1" }]))
        .mockReturnValueOnce(joinChain([
          { sequenceId: "seq-1", sequenceName: "Sahil", sequenceStatus: "active", total: 1, active: 1, completed: 0, enrolledAt: "2026-07-01" },
        ])),
    };
    const svc = new SequenceService(db as any);
    const result = await svc.listSequencesForList("ws-1", "list-1");
    expect(result).toHaveLength(1);
    expect(result![0]).toMatchObject({ sequenceId: "seq-1", sequenceName: "Sahil", total: 1, active: 1 });
  });

  it("returns sequences for member-selected (prospectId) enrollments", async () => {
    const db = {
      select: vi.fn()
        .mockReturnValueOnce(selectChain([{ id: "list-1" }]))
        .mockReturnValueOnce(selectChain([{ prospectId: "p-member" }]))
        .mockReturnValueOnce(joinChain([
          { sequenceId: "seq-2", sequenceName: "Quick Email Test", sequenceStatus: "active", total: 1, active: 0, completed: 1, enrolledAt: "2026-07-10" },
        ])),
    };
    const svc = new SequenceService(db as any);
    const result = await svc.listSequencesForList("ws-1", "list-1");
    expect(result).toHaveLength(1);
    expect(result![0]).toMatchObject({ sequenceId: "seq-2", sequenceName: "Quick Email Test", completed: 1 });
  });

  it("falls back to 'Deleted sequence' when sequence name is null", async () => {
    const db = {
      select: vi.fn()
        .mockReturnValueOnce(selectChain([{ id: "list-1" }]))
        .mockReturnValueOnce(selectChain([{ prospectId: "p-1" }]))
        .mockReturnValueOnce(joinChain([
          { sequenceId: "seq-orphan", sequenceName: null, sequenceStatus: null, total: 1, active: 0, completed: 1, enrolledAt: "2026-07-10" },
        ])),
    };
    const svc = new SequenceService(db as any);
    const result = await svc.listSequencesForList("ws-1", "list-1");
    expect(result![0]!.sequenceName).toBe("Deleted sequence");
    expect(result![0]!.sequenceStatus).toBe("archived");
  });
});

// ---------------------------------------------------------------------------
// buildSequenceService factory
// ---------------------------------------------------------------------------

describe("buildSequenceService", () => {
  it("returns null when db is null", () => {
    expect(buildSequenceService(null)).toBeNull();
  });

  it("returns a SequenceService when db is provided", () => {
    const db = makeDb();
    expect(buildSequenceService(db as any)).toBeInstanceOf(SequenceService);
  });
});

// ---------------------------------------------------------------------------
// exported constants
// ---------------------------------------------------------------------------

describe("exported enums", () => {
  it("STEP_TYPES contains core and branching types", () => {
    expect(STEP_TYPES).toContain("email");
    expect(STEP_TYPES).toContain("linkedin");
    expect(STEP_TYPES).toContain("wait");
    expect(STEP_TYPES).toContain("task");
    expect(STEP_TYPES).toContain("condition");
    expect(STEP_TYPES).toContain("goal");
  });

  it("SEQUENCE_MODES is A/B/C", () => {
    expect(SEQUENCE_MODES).toEqual(["A", "B", "C"]);
  });

  it("CONDITION_TYPES include LinkedIn invite states", () => {
    expect(CONDITION_TYPES).toContain("linkedin_invite_accepted");
    expect(CONDITION_TYPES).toContain("linkedin_invite_declined");
  });

  it("SEQUENCE_STATUSES contains the four lifecycle states", () => {
    expect(SEQUENCE_STATUSES).toContain("draft");
    expect(SEQUENCE_STATUSES).toContain("active");
    expect(SEQUENCE_STATUSES).toContain("paused");
    expect(SEQUENCE_STATUSES).toContain("archived");
  });
});
