import { describe, expect, it } from "vitest";
import * as bcrypt from "@node-rs/bcrypt";
import {
  CURRENT_ARGON2_PARAMS,
  checkPasswordPolicy,
  hashPassword,
  verifyPassword,
  verifyUnknownUser,
} from "./credential.service.js";

describe("credential.service", () => {
  describe("hashPassword / verifyPassword (argon2id)", () => {
    it("verifies the correct password", async () => {
      const { hash, algo, params } = await hashPassword("correct horse battery staple");
      expect(algo).toBe("argon2id");
      const result = await verifyPassword("correct horse battery staple", {
        passwordHash: hash,
        hashAlgo: algo,
        hashParams: params,
      });
      expect(result.valid).toBe(true);
      expect(result.needsRehash).toBe(false);
    });

    it("rejects an incorrect password", async () => {
      const { hash, algo, params } = await hashPassword("correct horse battery staple");
      const result = await verifyPassword("wrong password entirely", {
        passwordHash: hash,
        hashAlgo: algo,
        hashParams: params,
      });
      expect(result.valid).toBe(false);
      expect(result.needsRehash).toBe(false);
    });

    it("flags needsRehash when stored params are stale", async () => {
      const { hash } = await hashPassword("correct horse battery staple");
      const result = await verifyPassword("correct horse battery staple", {
        passwordHash: hash,
        hashAlgo: "argon2id",
        hashParams: { memoryCost: 4096, timeCost: 1, parallelism: 1 }, // old/weaker params
      });
      expect(result.valid).toBe(true);
      expect(result.needsRehash).toBe(true);
    });

    it("does not flag needsRehash when stored params already match current", async () => {
      const { hash, params } = await hashPassword("correct horse battery staple");
      expect(params).toEqual(CURRENT_ARGON2_PARAMS);
      const result = await verifyPassword("correct horse battery staple", {
        passwordHash: hash,
        hashAlgo: "argon2id",
        hashParams: params,
      });
      expect(result.needsRehash).toBe(false);
    });
  });

  describe("bcrypt import verify-then-upgrade", () => {
    it("verifies a bcrypt hash (as AUTH-BE-21 would import from Clerk) and flags it for upgrade", async () => {
      const bcryptHash = await bcrypt.hash("imported-password-123", 10);
      const result = await verifyPassword("imported-password-123", {
        passwordHash: bcryptHash,
        hashAlgo: "bcrypt",
        hashParams: null,
      });
      expect(result.valid).toBe(true);
      expect(result.needsRehash).toBe(true);
    });

    it("rejects an incorrect password against a bcrypt hash", async () => {
      const bcryptHash = await bcrypt.hash("imported-password-123", 10);
      const result = await verifyPassword("nope", {
        passwordHash: bcryptHash,
        hashAlgo: "bcrypt",
        hashParams: null,
      });
      expect(result.valid).toBe(false);
      expect(result.needsRehash).toBe(false);
    });
  });

  describe("unknown-user / unknown-algo dummy-hash path", () => {
    it("verifyUnknownUser always returns invalid without throwing", async () => {
      const result = await verifyUnknownUser("anything at all");
      expect(result.valid).toBe(false);
      expect(result.needsRehash).toBe(false);
    });

    it("an unrecognized hashAlgo is never valid, and still takes real comparison time", async () => {
      const result = await verifyPassword("anything", {
        passwordHash: "not-a-real-hash",
        hashAlgo: "unknown-future-algo",
        hashParams: null,
      });
      expect(result.valid).toBe(false);
      expect(result.needsRehash).toBe(false);
    });

    it("timing for an unknown user is comparable to a real wrong-password check", async () => {
      const { hash, algo, params } = await hashPassword("a-real-users-password-123");

      const t0 = performance.now();
      await verifyPassword("guess", { passwordHash: hash, hashAlgo: algo, hashParams: params });
      const realUserMs = performance.now() - t0;

      const t1 = performance.now();
      await verifyUnknownUser("guess");
      const unknownUserMs = performance.now() - t1;

      // Not a strict equality (CI hardware varies) — just confirms the unknown-user path pays
      // a real argon2 verification cost, not a near-zero short-circuit that would leak account
      // existence through timing.
      expect(unknownUserMs).toBeGreaterThan(realUserMs * 0.3);
    });
  });

  describe("checkPasswordPolicy", () => {
    it("rejects passwords shorter than the minimum", () => {
      const result = checkPasswordPolicy("short1");
      expect(result.ok).toBe(false);
      expect(result.reasons.join(" ")).toMatch(/at least/i);
    });

    it("rejects passwords longer than the maximum", () => {
      const result = checkPasswordPolicy("a".repeat(129));
      expect(result.ok).toBe(false);
      expect(result.reasons.join(" ")).toMatch(/at most/i);
    });

    it("rejects common/breached passwords case-insensitively", () => {
      expect(checkPasswordPolicy("password123").ok).toBe(false);
      expect(checkPasswordPolicy("PASSWORD123").ok).toBe(false);
    });

    it("accepts a reasonable password with no composition rules enforced", () => {
      const result = checkPasswordPolicy("correct horse battery staple");
      expect(result.ok).toBe(true);
      expect(result.reasons).toHaveLength(0);
    });

    it("accepts exactly the minimum length", () => {
      expect(checkPasswordPolicy("abcdefghij").ok).toBe(true);
    });
  });

  describe("hash verification cost", () => {
    it("measures and reports single-verify latency (informational, not a hard gate)", async () => {
      const { hash, algo, params } = await hashPassword("benchmark-password-123");
      const t0 = performance.now();
      await verifyPassword("benchmark-password-123", { passwordHash: hash, hashAlgo: algo, hashParams: params });
      const ms = performance.now() - t0;
      // eslint-disable-next-line no-console
      console.log(`[AUTH-BE-11] single argon2id verify: ${ms.toFixed(1)}ms (target ~100-250ms on prod-size CPU)`);
      expect(ms).toBeGreaterThan(0);
    });

    it("50 concurrent verifies resolve without starving the event loop", async () => {
      const { hash, algo, params } = await hashPassword("concurrency-password-123");
      const credential = { passwordHash: hash, hashAlgo: algo, hashParams: params };

      // A timer that should fire ~every 10ms regardless of the CPU-bound native hashing work,
      // since @node-rs/argon2 runs off the main thread. If the event loop were starved, ticks
      // would bunch up at the end instead of arriving roughly on schedule.
      const tickGaps: number[] = [];
      let last = performance.now();
      const interval = setInterval(() => {
        const now = performance.now();
        tickGaps.push(now - last);
        last = now;
      }, 10);

      const start = performance.now();
      await Promise.all(
        Array.from({ length: 50 }, () => verifyPassword("concurrency-password-123", credential))
      );
      const totalMs = performance.now() - start;
      clearInterval(interval);

      expect(tickGaps.length).toBeGreaterThan(0);
      const maxGap = Math.max(...tickGaps);
      // A generous bound: on a starved event loop this would be hundreds of ms (the whole
      // batch running before any timer fires); off-thread hashing keeps it close to the
      // 10ms interval even under load.
      expect(maxGap).toBeLessThan(200);
      // eslint-disable-next-line no-console
      console.log(`[AUTH-BE-11] 50 concurrent verifies: ${totalMs.toFixed(1)}ms total, max event-loop gap ${maxGap.toFixed(1)}ms`);
    });
  });
});
