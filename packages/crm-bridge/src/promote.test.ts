import { describe, expect, it, vi } from "vitest";
import { flagIfQualified, listPendingCandidates, promoteProspectToDeal } from "./promote.js";

function selectChain(result: unknown[], terminal: "limit" | "where" | "orderBy" = "limit") {
  const c: Record<string, unknown> = {};
  c.from = vi.fn().mockReturnValue(c);
  c.leftJoin = vi.fn().mockReturnValue(c);
  c.where = terminal === "where" ? vi.fn().mockResolvedValue(result) : vi.fn().mockReturnValue(c);
  c.orderBy = terminal === "orderBy" ? vi.fn().mockResolvedValue(result) : vi.fn().mockReturnValue(c);
  c.limit = terminal === "limit" ? vi.fn().mockResolvedValue(result) : vi.fn().mockReturnValue(c);
  return c;
}

function makeDb(selects: { result: unknown[]; terminal?: "limit" | "where" | "orderBy" }[]) {
  const db = { select: vi.fn(), insert: vi.fn(), update: vi.fn() };
  for (const { result, terminal } of selects) {
    db.select.mockReturnValueOnce(selectChain(result, terminal));
  }
  db.insert.mockReturnValue({ values: vi.fn().mockResolvedValue(undefined) });
  db.update.mockReturnValue({ set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) }) });
  return db;
}

describe("flagIfQualified", () => {
  it("does nothing when the score is below the workspace threshold", async () => {
    const db = makeDb([{ result: [{ dealPromotionThreshold: 80 }] }]);
    await flagIfQualified(db as any, "ws-1", "prospect-1", 70);
    expect(db.insert).not.toHaveBeenCalled();
  });

  it("inserts a pending candidate when the score meets the threshold and none exists yet", async () => {
    const db = makeDb([
      { result: [{ dealPromotionThreshold: 80 }] }, // workspace lookup
      { result: [] }, // no existing candidate
    ]);
    await flagIfQualified(db as any, "ws-1", "prospect-1", 92);
    expect(db.insert).toHaveBeenCalledTimes(1);
  });

  it("updates the score in place for an existing pending candidate instead of inserting again", async () => {
    const db = makeDb([
      { result: [{ dealPromotionThreshold: 80 }] },
      { result: [{ id: "cand-1", status: "pending" }] },
    ]);
    await flagIfQualified(db as any, "ws-1", "prospect-1", 95);
    expect(db.insert).not.toHaveBeenCalled();
    expect(db.update).toHaveBeenCalledTimes(1);
  });

  it("leaves an already-promoted candidate alone on re-score", async () => {
    const db = makeDb([
      { result: [{ dealPromotionThreshold: 80 }] },
      { result: [{ id: "cand-1", status: "promoted" }] },
    ]);
    await flagIfQualified(db as any, "ws-1", "prospect-1", 95);
    expect(db.insert).not.toHaveBeenCalled();
    expect(db.update).not.toHaveBeenCalled();
  });
});

describe("listPendingCandidates", () => {
  it("maps snapshot fields onto the DTO", async () => {
    const db = makeDb([
      {
        result: [
          {
            id: "cand-1",
            prospectId: "prospect-1",
            score: 92,
            createdAt: new Date("2026-01-01T00:00:00Z"),
            snapshot: { fullName: "Alice Chen", companyName: "Acme Inc" },
          },
        ],
        terminal: "orderBy",
      },
    ]);
    const result = await listPendingCandidates(db as any, "ws-1");
    expect(result).toEqual([
      {
        id: "cand-1",
        prospectId: "prospect-1",
        score: 92,
        fullName: "Alice Chen",
        companyName: "Acme Inc",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    ]);
  });
});

function insertReturning(result: unknown[]) {
  return { values: vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue(result) }) };
}

function makeTx(selects: { result: unknown[]; terminal?: "limit" | "where" | "orderBy" }[], inserts: (() => unknown)[]) {
  const tx = { select: vi.fn(), insert: vi.fn(), update: vi.fn() };
  for (const { result, terminal } of selects) {
    tx.select.mockReturnValueOnce(selectChain(result, terminal));
  }
  for (const factory of inserts) {
    tx.insert.mockReturnValueOnce(factory());
  }
  tx.update.mockReturnValue({ set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) }) });
  return tx;
}

describe("promoteProspectToDeal", () => {
  it("throws when the candidate does not exist", async () => {
    const db = makeDb([{ result: [] }]);
    await expect(promoteProspectToDeal(db as any, "ws-1", "cand-1", "user-1")).rejects.toThrow(
      "promotion_candidate_not_found"
    );
  });

  it("throws when the candidate is already promoted", async () => {
    const db = makeDb([{ result: [{ id: "cand-1", status: "promoted", prospectId: "prospect-1" }] }]);
    await expect(promoteProspectToDeal(db as any, "ws-1", "cand-1", "user-1")).rejects.toThrow(
      "promotion_candidate_already_promoted"
    );
  });

  it("creates company, contact, and deal, and marks the candidate promoted", async () => {
    const candidate = { id: "cand-1", status: "pending", prospectId: "prospect-1" };
    const tx = makeTx(
      [
        { result: [{ snapshot: { fullName: "Alice Chen", companyName: "Acme Inc", companyDomain: "acme.com" } }] }, // prospectActivations
        { result: [] }, // no existing company
        { result: [] }, // no existing contact
        { result: [{ id: "pipeline-1", workspaceId: "ws-1", isDefault: true }] }, // default pipeline
        { result: [{ id: "stage-1" }], terminal: "orderBy" }, // first stage
      ],
      [
        () => insertReturning([{ id: "company-1" }]),
        () => insertReturning([]), // audit log for company
        () => insertReturning([{ id: "contact-1" }]),
        () => insertReturning([]), // audit log for contact
        () => insertReturning([{ id: "deal-1" }]),
        () => insertReturning([]), // audit log for deal
      ]
    );
    const db = {
      select: vi.fn().mockReturnValueOnce(selectChain([candidate])),
      transaction: vi.fn(async (cb: (tx: unknown) => unknown) => cb(tx)),
    };

    const result = await promoteProspectToDeal(db as any, "ws-1", "cand-1", "user-1");

    expect(result).toEqual({ companyId: "company-1", contactId: "contact-1", dealId: "deal-1" });
    expect(tx.update).toHaveBeenCalled(); // candidate marked promoted
  });
});
