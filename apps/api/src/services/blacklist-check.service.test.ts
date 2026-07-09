import { describe, expect, it, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Hoist mocks before module import so the module-level `new Resolver()` call
// receives the mock class, not the real one.
// ---------------------------------------------------------------------------

const { mockResolve4 } = vi.hoisted(() => ({ mockResolve4: vi.fn() }));

vi.mock("node:dns/promises", () => ({
  Resolver: vi.fn().mockImplementation(() => ({
    setServers: vi.fn(),
    resolve4: mockResolve4,
  })),
}));

import { checkDomainBlacklist } from "./blacklist-check.service.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const CLEAN_IP = "1.2.3.4";
const REVERSED_IP = "4.3.2.1";
const DNSBLS = ["zen.spamhaus.org", "bl.spamcop.net", "dnsbl.sorbs.net", "b.barracudacentral.org"];

function setupCleanDomain() {
  // First call: resolve domain → IP
  // Subsequent calls (one per DNSBL): throw NXDOMAIN = not listed
  mockResolve4.mockResolvedValueOnce([CLEAN_IP]);
  mockResolve4.mockRejectedValue(Object.assign(new Error("NXDOMAIN"), { code: "ENOTFOUND" }));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("checkDomainBlacklist", () => {
  beforeEach(() => {
    mockResolve4.mockReset();
  });

  describe("clean domain", () => {
    it("returns status: clean and empty listedOn when no DNSBL matches", async () => {
      setupCleanDomain();
      const result = await checkDomainBlacklist("example.com");
      expect(result.status).toBe("clean");
      expect(result.listedOn).toEqual([]);
      expect(result.error).toBeUndefined();
    });

    it("resolves the domain IP before querying DNSBLs", async () => {
      setupCleanDomain();
      await checkDomainBlacklist("example.com");
      // First call should be for the domain itself
      expect(mockResolve4).toHaveBeenNthCalledWith(1, "example.com");
    });

    it("queries each DNSBL with the reversed IP prefix", async () => {
      setupCleanDomain();
      await checkDomainBlacklist("example.com");
      for (const dnsbl of DNSBLS) {
        expect(mockResolve4).toHaveBeenCalledWith(`${REVERSED_IP}.${dnsbl}`);
      }
    });

    it("makes 5 total DNS calls (1 IP resolve + 4 DNSBL checks)", async () => {
      setupCleanDomain();
      await checkDomainBlacklist("example.com");
      expect(mockResolve4).toHaveBeenCalledTimes(5);
    });
  });

  describe("blacklisted domain", () => {
    it("returns status: blacklisted when one DNSBL matches", async () => {
      // Domain resolves to IP
      mockResolve4.mockResolvedValueOnce([CLEAN_IP]);
      // zen.spamhaus.org hit (returns a record)
      mockResolve4.mockResolvedValueOnce(["127.0.0.2"]);
      // remaining 3 DNSBLs: clean
      mockResolve4.mockRejectedValue(new Error("NXDOMAIN"));

      const result = await checkDomainBlacklist("badactor.com");
      expect(result.status).toBe("blacklisted");
      expect(result.listedOn).toEqual(["zen.spamhaus.org"]);
    });

    it("returns all matching DNSBLs when multiple lists match", async () => {
      mockResolve4.mockResolvedValueOnce([CLEAN_IP]);
      // 4 DNSBL checks: first two listed, last two clean
      mockResolve4.mockResolvedValueOnce(["127.0.0.2"]);   // zen.spamhaus.org
      mockResolve4.mockResolvedValueOnce(["127.0.0.2"]);   // bl.spamcop.net
      mockResolve4.mockRejectedValue(new Error("NXDOMAIN")); // dnsbl.sorbs.net + b.barracudacentral.org

      const result = await checkDomainBlacklist("spammer.com");
      expect(result.status).toBe("blacklisted");
      expect(result.listedOn).toEqual(["zen.spamhaus.org", "bl.spamcop.net"]);
    });

    it("returns status: blacklisted when all 4 DNSBLs match", async () => {
      mockResolve4.mockResolvedValueOnce([CLEAN_IP]);
      mockResolve4.mockResolvedValue(["127.0.0.2"]);

      const result = await checkDomainBlacklist("very-bad.com");
      expect(result.status).toBe("blacklisted");
      expect(result.listedOn).toHaveLength(4);
    });
  });

  describe("error cases", () => {
    it("returns status: error when domain cannot be resolved", async () => {
      mockResolve4.mockRejectedValueOnce(Object.assign(new Error("SERVFAIL"), { code: "ESERVFAIL" }));

      const result = await checkDomainBlacklist("nonexistent.invalid");
      expect(result.status).toBe("error");
      expect(result.listedOn).toEqual([]);
      expect(result.error).toMatch(/Could not resolve IP/);
    });

    it("includes the original error message in the error field", async () => {
      const originalError = new Error("getaddrinfo ENOTFOUND nope.invalid");
      mockResolve4.mockRejectedValueOnce(originalError);

      const result = await checkDomainBlacklist("nope.invalid");
      expect(result.error).toContain("getaddrinfo ENOTFOUND nope.invalid");
    });

    it("returns status: error when IP resolution returns an empty array", async () => {
      mockResolve4.mockResolvedValueOnce([]);

      const result = await checkDomainBlacklist("no-ip.example");
      expect(result.status).toBe("error");
      expect(result.error).toMatch(/no IPv4/i);
    });

    it("treats DNSBL lookup errors as not-listed (NXDOMAIN-equivalent)", async () => {
      // IP resolves fine
      mockResolve4.mockResolvedValueOnce(["5.6.7.8"]);
      // All DNSBL lookups throw (network error or NXDOMAIN)
      mockResolve4.mockRejectedValue(new Error("NXDOMAIN"));

      const result = await checkDomainBlacklist("legitimate.com");
      // Should be clean, not an error — DNSBL errors mean "not listed"
      expect(result.status).toBe("clean");
      expect(result.listedOn).toEqual([]);
    });

    it("uses only the first resolved IP for DNSBL checks", async () => {
      mockResolve4.mockResolvedValueOnce(["10.0.0.1", "10.0.0.2"]);
      mockResolve4.mockRejectedValue(new Error("NXDOMAIN"));

      await checkDomainBlacklist("multi-ip.com");
      // 10.0.0.1 reversed = 1.0.0.10; only this prefix should appear in DNSBL calls
      expect(mockResolve4).toHaveBeenCalledWith(expect.stringContaining("1.0.0.10."));
      // The second IP (10.0.0.2 → 2.0.0.10) should never appear
      expect(mockResolve4).not.toHaveBeenCalledWith(expect.stringContaining("2.0.0.10."));
    });
  });

  describe("IP reversal", () => {
    it("correctly reverses the IP octets for DNSBL queries", async () => {
      mockResolve4.mockResolvedValueOnce(["192.168.1.100"]);
      mockResolve4.mockRejectedValue(new Error("NXDOMAIN"));

      await checkDomainBlacklist("test.example");
      // 192.168.1.100 reversed = 100.1.168.192
      expect(mockResolve4).toHaveBeenCalledWith(
        expect.stringContaining("100.1.168.192.")
      );
    });
  });
});
