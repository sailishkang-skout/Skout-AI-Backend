import { describe, expect, it, vi } from "vitest";
import type { Env } from "../config/env.js";
import {
  addSuppression,
  buildUnsubscribeUrl,
  decodeUnsubscribeToken,
  isSuppressed,
  listSuppressions,
  trackingSecret,
} from "./suppression.service.js";

function selectChain(result: unknown[]) {
  const c = {} as Record<string, ReturnType<typeof vi.fn>>;
  c.from = vi.fn().mockReturnValue(c);
  c.where = vi.fn().mockReturnValue(c);
  c.limit = vi.fn().mockResolvedValue(result);
  return c;
}

function makeDb(selectResult: unknown[]) {
  const returning = vi.fn().mockResolvedValue([
    { id: "row-1", workspaceId: "ws-1", email: "test@example.com", reason: "unsubscribed", createdAt: new Date("2026-01-01T00:00:00Z") },
  ]);
  const insertValues = vi.fn().mockReturnValue({ onConflictDoNothing: vi.fn().mockReturnValue({ returning }) });
  return {
    select: vi.fn().mockReturnValue(selectChain(selectResult)),
    insert: vi.fn().mockReturnValue({ values: insertValues }),
    __insertValues: insertValues,
  } as any;
}

const env = { TRACKING_SIGNING_SECRET: "tracking-secret", PORT: 3001 } as unknown as Env;

describe("suppression.service", () => {
  describe("trackingSecret", () => {
    it("prefers TRACKING_SIGNING_SECRET", () => {
      expect(trackingSecret({ TRACKING_SIGNING_SECRET: "a", INTEGRATION_ENCRYPTION_KEY: "b" } as Env)).toBe("a");
    });

    it("falls back to INTEGRATION_ENCRYPTION_KEY", () => {
      expect(trackingSecret({ INTEGRATION_ENCRYPTION_KEY: "b" } as Env)).toBe("b");
    });

    it("falls back to a dev default when neither is set outside production", () => {
      expect(trackingSecret({} as Env)).toBe("dev-insecure-tracking-secret");
      expect(trackingSecret({ NODE_ENV: "development" } as Env)).toBe("dev-insecure-tracking-secret");
    });

    it("refuses the insecure fallback in production", () => {
      expect(() => trackingSecret({ NODE_ENV: "production" } as Env)).toThrow(/must be set in production/);
    });
  });

  describe("isSuppressed", () => {
    it("returns true when a matching row exists", async () => {
      const db = makeDb([{ id: "row-1" }]);
      await expect(isSuppressed(db, "ws-1", "Test@Example.com")).resolves.toBe(true);
    });

    it("returns false when no matching row exists", async () => {
      const db = makeDb([]);
      await expect(isSuppressed(db, "ws-1", "nobody@example.com")).resolves.toBe(false);
    });
  });

  describe("addSuppression", () => {
    it("normalizes the email before inserting", async () => {
      const db = makeDb([]);
      await addSuppression(db, "ws-1", "  Test@Example.com  ", "bounced");
      expect(db.__insertValues).toHaveBeenCalledWith({
        workspaceId: "ws-1",
        email: "test@example.com",
        reason: "bounced",
      });
    });

    it("defaults reason to unsubscribed", async () => {
      const db = makeDb([]);
      await addSuppression(db, "ws-1", "a@b.com");
      expect(db.__insertValues).toHaveBeenCalledWith({
        workspaceId: "ws-1",
        email: "a@b.com",
        reason: "unsubscribed",
      });
    });
  });

  describe("buildUnsubscribeUrl / decodeUnsubscribeToken", () => {
    it("round-trips workspaceId + normalized email through the URL token", () => {
      const url = buildUnsubscribeUrl(env, "ws-1", "Test@Example.com");
      expect(url).toMatch(/^http:\/\/localhost:3001\/api\/v1\/unsubscribe\//);
      const token = url.split("/unsubscribe/")[1]!;
      expect(decodeUnsubscribeToken(env, token)).toEqual({ workspaceId: "ws-1", email: "test@example.com" });
    });

    it("uses API_PUBLIC_URL as the base when configured", () => {
      const url = buildUnsubscribeUrl(
        { ...env, API_PUBLIC_URL: "https://api.skout.ai" } as Env,
        "ws-1",
        "a@b.com"
      );
      expect(url.startsWith("https://api.skout.ai/api/v1/unsubscribe/")).toBe(true);
    });

    it("returns null for an invalid token", () => {
      expect(decodeUnsubscribeToken(env, "garbage")).toBeNull();
    });
  });

  describe("listSuppressions", () => {
    function listDb(rows: unknown[], count: number) {
      const rowsChain: any = {};
      for (const m of ["from", "where", "orderBy", "limit"]) rowsChain[m] = vi.fn().mockReturnValue(rowsChain);
      rowsChain.offset = vi.fn().mockResolvedValue(rows);
      const countChain: any = { from: vi.fn().mockReturnThis(), where: vi.fn().mockResolvedValue([{ total: count }]) };
      const select = vi.fn().mockReturnValueOnce(rowsChain).mockReturnValueOnce(countChain);
      return { select } as any;
    }

    it("returns the count(*) total rather than the page length", async () => {
      const row = { id: "r1", workspaceId: "ws-1", email: "a@b.co", reason: "x", createdAt: new Date("2026-01-01T00:00:00Z") };
      const out = await listSuppressions(listDb([row], 137), "ws-1", { limit: 1, email: "50%_off" });
      expect(out.data).toHaveLength(1);
      expect(out.total).toBe(137);
    });
  });
});
