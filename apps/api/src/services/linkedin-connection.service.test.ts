import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("./unipile.client.js", () => ({
  linkedinPublicIdentifierFromUrl: vi.fn((url: string) => {
    const m = url.match(/linkedin\.com\/in\/([^/]+)/);
    return m ? m[1] : null;
  }),
  unipileListRelations: vi.fn(),
}));

vi.mock("./linkedin-account.service.js", () => ({
  LinkedinAccountService: vi.fn().mockImplementation(() => ({
    list: vi.fn(),
    resolveConfig: vi.fn().mockResolvedValue({}),
  })),
}));

import { checkLinkedinConnectionStatus } from "./linkedin-connection.service.js";
import { unipileListRelations } from "./unipile.client.js";
import { LinkedinAccountService } from "./linkedin-account.service.js";

const WORKSPACE_ID = "ws-1";
const PROSPECT_ID = "prospect-1";
const LINKEDIN_URL = "https://linkedin.com/in/jane-doe";

function makeDb(existing: Record<string, unknown> | null) {
  const updateSet = vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) });
  const insertValues = vi.fn().mockReturnValue({ onConflictDoNothing: vi.fn().mockResolvedValue(undefined) });
  const selectChain = {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    limit: vi.fn().mockResolvedValue(existing ? [existing] : []),
  };
  return {
    select: vi.fn().mockReturnValue(selectChain),
    update: vi.fn().mockReturnValue({ set: updateSet }),
    insert: vi.fn().mockReturnValue({ values: insertValues }),
    _updateSet: updateSet,
    _insertValues: insertValues,
  } as any;
}

describe("checkLinkedinConnectionStatus", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("short-circuits without calling Unipile once a connection is already confirmed accepted", async () => {
    const db = makeDb({ id: "conn-1", status: "accepted", checkedAt: new Date() });
    const status = await checkLinkedinConnectionStatus({} as any, db, {
      workspaceId: WORKSPACE_ID,
      prospectId: PROSPECT_ID,
      linkedinUrl: LINKEDIN_URL,
    });
    expect(status).toBe("accepted");
    expect(unipileListRelations).not.toHaveBeenCalled();
  });

  it("returns the cached status without re-polling when checked recently", async () => {
    const db = makeDb({ id: "conn-1", status: "pending", checkedAt: new Date() }); // just now
    const status = await checkLinkedinConnectionStatus({} as any, db, {
      workspaceId: WORKSPACE_ID,
      prospectId: PROSPECT_ID,
      linkedinUrl: LINKEDIN_URL,
    });
    expect(status).toBe("pending");
    expect(unipileListRelations).not.toHaveBeenCalled();
  });

  it("marks accepted when the prospect's public identifier shows up in first-degree relations", async () => {
    vi.mocked(LinkedinAccountService).mockImplementation(
      () =>
        ({
          list: vi.fn().mockResolvedValue([{ id: "acct-1", status: "active" }]),
          resolveConfig: vi.fn().mockResolvedValue({}),
        }) as any
    );
    vi.mocked(unipileListRelations).mockResolvedValue({
      items: [{ public_identifier: "jane-doe" }],
      cursor: null,
    });

    // Stale/no cached row — forces a real check.
    const db = makeDb(null);
    const status = await checkLinkedinConnectionStatus({} as any, db, {
      workspaceId: WORKSPACE_ID,
      prospectId: PROSPECT_ID,
      linkedinUrl: LINKEDIN_URL,
    });

    expect(status).toBe("accepted");
    expect(db._insertValues).toHaveBeenCalledWith(expect.objectContaining({ status: "accepted" }));
  });

  it("stays pending when no relation matches", async () => {
    vi.mocked(LinkedinAccountService).mockImplementation(
      () =>
        ({
          list: vi.fn().mockResolvedValue([{ id: "acct-1", status: "active" }]),
          resolveConfig: vi.fn().mockResolvedValue({}),
        }) as any
    );
    vi.mocked(unipileListRelations).mockResolvedValue({
      items: [{ public_identifier: "someone-else" }],
      cursor: null,
    });

    const db = makeDb(null);
    const status = await checkLinkedinConnectionStatus({} as any, db, {
      workspaceId: WORKSPACE_ID,
      prospectId: PROSPECT_ID,
      linkedinUrl: LINKEDIN_URL,
    });

    expect(status).toBe("pending");
    expect(db._insertValues).toHaveBeenCalledWith(expect.objectContaining({ status: "pending" }));
  });

  it("never flags accepted when there are no active LinkedIn accounts to check against", async () => {
    vi.mocked(LinkedinAccountService).mockImplementation(
      () =>
        ({
          list: vi.fn().mockResolvedValue([{ id: "acct-1", status: "paused" }]),
          resolveConfig: vi.fn().mockResolvedValue({}),
        }) as any
    );

    const db = makeDb(null);
    const status = await checkLinkedinConnectionStatus({} as any, db, {
      workspaceId: WORKSPACE_ID,
      prospectId: PROSPECT_ID,
      linkedinUrl: LINKEDIN_URL,
    });

    expect(status).toBe("pending");
    expect(unipileListRelations).not.toHaveBeenCalled();
  });
});
