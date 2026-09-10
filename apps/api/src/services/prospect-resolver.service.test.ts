import { describe, expect, it, vi, beforeEach } from "vitest";

const findExistingProspect = vi.fn();

vi.mock("./search.service.js", () => ({
  SearchService: vi.fn().mockImplementation(() => ({ findExistingProspect })),
}));

import { resolveProspectFields } from "./prospect-resolver.service.js";
import type { Env } from "../config/env.js";

type Terminal = "where" | "orderBy";

function selectChain(result: unknown[], terminal: Terminal) {
  const c = {} as Record<string, ReturnType<typeof vi.fn>>;
  c.from = vi.fn().mockReturnValue(c);
  if (terminal === "where") {
    c.where = vi.fn().mockResolvedValue(result);
  } else {
    c.where = vi.fn().mockReturnValue(c);
    c.orderBy = vi.fn().mockResolvedValue(result);
  }
  return c;
}

function makeDb(
  activationRows: unknown[],
  enrichmentRows: unknown[] = [],
  opts?: { skipEnrichment?: boolean; phoneRows?: unknown[] }
) {
  const select = vi.fn();
  select.mockReturnValueOnce(selectChain(activationRows, "where"));
  if (!opts?.skipEnrichment) {
    // email enrichment, then phone enrichment
    select.mockReturnValueOnce(selectChain(enrichmentRows, "orderBy"));
    select.mockReturnValueOnce(selectChain(opts?.phoneRows ?? [], "orderBy"));
  }
  return { select } as any;
}

const env = {} as Env;

describe("resolveProspectFields", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns null when the prospect doc cannot be found", async () => {
    findExistingProspect.mockResolvedValue(null);
    const db = makeDb([], [], { skipEnrichment: true });
    await expect(resolveProspectFields(env, db, "ws-1", "p-1")).resolves.toBeNull();
  });

  it("prefers the activation snapshot email over work enrichment/doc email", async () => {
    findExistingProspect.mockResolvedValue({ fullName: "Ada Lovelace", email: "doc@acme.com" });
    const db = makeDb([{ snapshot: { email: "snapshot@example.com" } }]);

    const result = await resolveProspectFields(env, db, "ws-1", "p-1");
    expect(result?.email).toBe("snapshot@example.com");
    expect(result?.firstName).toBe("Ada");
    expect(result?.lastName).toBe("Lovelace");
  });

  it("prefers OpenSearch personal email over enriched work snapshot email", async () => {
    findExistingProspect.mockResolvedValue({
      fullName: "Neeraj Singh",
      email: "neeraj190499@gmail.com",
    });
    const db = makeDb([{ snapshot: { email: "neeraj.singh@vdart.com" } }], [
      { fieldValue: "neeraj.singh@vdart.com", isPrimary: true },
    ]);

    const result = await resolveProspectFields(env, db, "ws-1", "p-1");
    expect(result?.email).toBe("neeraj190499@gmail.com");
  });

  it("falls back to a primary enrichment result when no snapshot email exists", async () => {
    findExistingProspect.mockResolvedValue({ fullName: "Ada Lovelace", email: "doc@acme.com" });
    const db = makeDb(
      [],
      [
        { fieldValue: "secondary@example.com", isPrimary: false },
        { fieldValue: "primary@example.com", isPrimary: true },
      ]
    );

    const result = await resolveProspectFields(env, db, "ws-1", "p-1");
    expect(result?.email).toBe("primary@example.com");
  });

  it("falls back to the first enrichment result when none are marked primary", async () => {
    findExistingProspect.mockResolvedValue({ fullName: "Ada Lovelace", email: "doc@acme.com" });
    const db = makeDb([], [{ fieldValue: "first@example.com", isPrimary: false }]);

    const result = await resolveProspectFields(env, db, "ws-1", "p-1");
    expect(result?.email).toBe("first@example.com");
  });

  it("falls back to the OpenSearch doc email when no snapshot or enrichment email exists", async () => {
    findExistingProspect.mockResolvedValue({ fullName: "Ada Lovelace", email: "doc@acme.com" });
    const db = makeDb([], []);

    const result = await resolveProspectFields(env, db, "ws-1", "p-1");
    expect(result?.email).toBe("doc@acme.com");
  });

  it("leaves email undefined when no source provides one", async () => {
    findExistingProspect.mockResolvedValue({ fullName: "Ada Lovelace" });
    const db = makeDb([], []);

    const result = await resolveProspectFields(env, db, "ws-1", "p-1");
    expect(result?.email).toBeUndefined();
  });

  it("splits a single-word full name into firstName only", async () => {
    findExistingProspect.mockResolvedValue({ fullName: "Cher" });
    const db = makeDb([], []);

    const result = await resolveProspectFields(env, db, "ws-1", "p-1");
    expect(result?.firstName).toBe("Cher");
    expect(result?.lastName).toBe("");
  });
});
