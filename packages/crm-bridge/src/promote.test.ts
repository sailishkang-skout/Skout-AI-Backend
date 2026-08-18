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
  db.insert.mockReturnValue({
    values: vi.fn().mockReturnValue({ onConflictDoNothing: vi.fn().mockResolvedValue(undefined) }),
  });
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

function updateReturning(result: unknown[]) {
  return { set: vi.fn().mockReturnValue({ where: vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue(result) }) }) };
}

function makeTx(selects: { result: unknown[]; terminal?: "limit" | "where" | "orderBy" }[], inserts: (() => unknown)[]) {
  const tx = { select: vi.fn(), insert: vi.fn(), update: vi.fn() };
  for (const { result, terminal } of selects) {
    tx.select.mockReturnValueOnce(selectChain(result, terminal));
  }
  for (const factory of inserts) {
    tx.insert.mockReturnValueOnce(factory());
  }
  return tx;
}

describe("promoteProspectToDeal", () => {
  it("throws when the candidate does not exist", async () => {
    const tx = {
      update: vi.fn().mockReturnValueOnce(updateReturning([])), // atomic claim: no row matched
      select: vi.fn().mockReturnValueOnce(selectChain([])), // existence check: doesn't exist at all
      insert: vi.fn(),
    };
    const db = { transaction: vi.fn(async (cb: (tx: unknown) => unknown) => cb(tx)) };
    await expect(promoteProspectToDeal(db as any, "ws-1", "cand-1", "user-1")).rejects.toThrow(
      "promotion_candidate_not_found"
    );
  });

  it("throws when the candidate is already promoted", async () => {
    const tx = {
      update: vi.fn().mockReturnValueOnce(updateReturning([])), // atomic claim: no row matched (not pending)
      select: vi.fn().mockReturnValueOnce(selectChain([{ id: "cand-1" }])), // existence check: it does exist
      insert: vi.fn(),
    };
    const db = { transaction: vi.fn(async (cb: (tx: unknown) => unknown) => cb(tx)) };
    await expect(promoteProspectToDeal(db as any, "ws-1", "cand-1", "user-1")).rejects.toThrow(
      "promotion_candidate_already_promoted"
    );
  });

  it("creates company, contact, and deal, and marks the candidate promoted atomically", async () => {
    const claimedCandidate = { id: "cand-1", status: "promoted", prospectId: "prospect-1" };
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
    tx.update = vi.fn().mockReturnValueOnce(updateReturning([claimedCandidate]));
    const db = {
      transaction: vi.fn(async (cb: (tx: unknown) => unknown) => cb(tx)),
    };

    const result = await promoteProspectToDeal(db as any, "ws-1", "cand-1", "user-1");

    expect(result).toEqual({ companyId: "company-1", contactId: "contact-1", dealId: "deal-1" });
    // Exactly one update — the atomic claim itself doubles as the "mark promoted" write.
    expect(tx.update).toHaveBeenCalledTimes(1);
  });

  it("never lets two concurrent promotes both succeed for the same candidate", async () => {
    const claimedCandidate = { id: "cand-1", status: "promoted", prospectId: "prospect-1" };
    const winnerTx = makeTx(
      [
        { result: [{ snapshot: { fullName: "Alice Chen", companyName: "Acme Inc" } }] },
        { result: [] },
        { result: [] },
        { result: [{ id: "pipeline-1", workspaceId: "ws-1", isDefault: true }] },
        { result: [{ id: "stage-1" }], terminal: "orderBy" },
      ],
      [
        () => insertReturning([{ id: "company-1" }]),
        () => insertReturning([]),
        () => insertReturning([{ id: "contact-1" }]),
        () => insertReturning([]),
        () => insertReturning([{ id: "deal-1" }]),
        () => insertReturning([]),
      ]
    );
    winnerTx.update = vi.fn().mockReturnValueOnce(updateReturning([claimedCandidate]));

    const loserTx = {
      update: vi.fn().mockReturnValueOnce(updateReturning([])), // lost the atomic claim
      select: vi.fn().mockReturnValueOnce(selectChain([{ id: "cand-1" }])), // it exists, just not pending anymore
      insert: vi.fn(),
    };

    const db = {
      transaction: vi
        .fn()
        .mockImplementationOnce(async (cb: (tx: unknown) => unknown) => cb(winnerTx))
        .mockImplementationOnce(async (cb: (tx: unknown) => unknown) => cb(loserTx)),
    };

    const [winnerResult, loserResult] = await Promise.allSettled([
      promoteProspectToDeal(db as any, "ws-1", "cand-1", "user-1"),
      promoteProspectToDeal(db as any, "ws-1", "cand-1", "user-2"),
    ]);

    expect(winnerResult.status).toBe("fulfilled");
    expect(loserResult.status).toBe("rejected");
    if (loserResult.status === "rejected") {
      expect((loserResult.reason as Error).message).toBe("promotion_candidate_already_promoted");
    }
  });
});
