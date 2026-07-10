import { describe, expect, it, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mock node:dns so tests never hit the network.
// The module exports `promises as dns` and the `MxRecord` type.
// ---------------------------------------------------------------------------

const { mockResolveTxt, mockResolveMx } = vi.hoisted(() => ({
  mockResolveTxt: vi.fn(),
  mockResolveMx: vi.fn(),
}));

vi.mock("node:dns", () => ({
  promises: {
    resolveTxt: mockResolveTxt,
    resolveMx: mockResolveMx,
  },
}));

import {
  checkDomainDns,
  generateExpectedDnsRecords,
  type DnsCheckResult,
} from "./domain-dns.service.js";

// ---------------------------------------------------------------------------
// Constants matching the service's internal values
// ---------------------------------------------------------------------------

const SPF_INCLUDE = "_spf.skout.dev";
const DKIM_SELECTOR = "skout";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resolvedTxt(records: string[]): Promise<string[][]> {
  return Promise.resolve(records.map((r) => [r]));
}

function resolvedMx(exchanges: { priority: number; exchange: string }[]): Promise<typeof exchanges> {
  return Promise.resolve(exchanges);
}

function rejectedDns(code = "ENOTFOUND"): Promise<never> {
  return Promise.reject(Object.assign(new Error(code), { code }));
}

// ---------------------------------------------------------------------------
// generateExpectedDnsRecords — pure function, no mocking needed
// ---------------------------------------------------------------------------

describe("generateExpectedDnsRecords", () => {
  it("returns 4 records for the given domain", () => {
    const records = generateExpectedDnsRecords("example.com");
    expect(records).toHaveLength(4);
  });

  it("all records have status: unknown", () => {
    const records = generateExpectedDnsRecords("example.com");
    expect(records.every((r) => r.status === "unknown")).toBe(true);
  });

  it("includes an SPF TXT record at the apex domain", () => {
    const records = generateExpectedDnsRecords("example.com");
    const spf = records.find((r) => r.purpose === "SPF");
    expect(spf).toBeDefined();
    expect(spf!.type).toBe("TXT");
    expect(spf!.name).toBe("example.com");
    expect(spf!.value).toContain(SPF_INCLUDE);
  });

  it("includes a DKIM TXT record at the correct selector subdomain", () => {
    const records = generateExpectedDnsRecords("example.com");
    const dkim = records.find((r) => r.purpose === "DKIM");
    expect(dkim).toBeDefined();
    expect(dkim!.name).toBe(`${DKIM_SELECTOR}._domainkey.example.com`);
    expect(dkim!.value).toMatch(/^v=DKIM1/);
  });

  it("includes a DMARC TXT record at _dmarc subdomain", () => {
    const records = generateExpectedDnsRecords("example.com");
    const dmarc = records.find((r) => r.purpose === "DMARC");
    expect(dmarc).toBeDefined();
    expect(dmarc!.name).toBe("_dmarc.example.com");
    expect(dmarc!.value).toMatch(/^v=DMARC1/);
  });

  it("includes an MX record at the apex domain", () => {
    const records = generateExpectedDnsRecords("example.com");
    const mx = records.find((r) => r.purpose === "MX");
    expect(mx).toBeDefined();
    expect(mx!.type).toBe("MX");
    expect(mx!.name).toBe("example.com");
  });

  it("uses the supplied domain in all record names", () => {
    const records = generateExpectedDnsRecords("mycompany.io");
    const names = records.map((r) => r.name);
    expect(names).toContain("mycompany.io");
    expect(names).toContain(`${DKIM_SELECTOR}._domainkey.mycompany.io`);
    expect(names).toContain("_dmarc.mycompany.io");
  });
});

// ---------------------------------------------------------------------------
// checkDomainDns — all DNS checks pass
// ---------------------------------------------------------------------------

describe("checkDomainDns — all passing", () => {
  beforeEach(() => {
    mockResolveTxt.mockReset();
    mockResolveMx.mockReset();
  });

  it("returns pass for all four records when DNS is fully configured", async () => {
    mockResolveTxt
      .mockImplementation((name: string) => {
        if (name === "example.com") return resolvedTxt([`v=spf1 include:${SPF_INCLUDE} ~all`]);
        if (name.startsWith(`${DKIM_SELECTOR}._domainkey`)) return resolvedTxt(["v=DKIM1; k=rsa; p=ABCD"]);
        if (name.startsWith("_dmarc")) return resolvedTxt(["v=DMARC1; p=reject; rua=mailto:dmarc@example.com"]);
        return rejectedDns();
      });
    mockResolveMx.mockResolvedValue([{ priority: 10, exchange: "mail.example.com" }]);

    const result = await checkDomainDns("example.com");
    expect(result.spf).toBe("pass");
    expect(result.dkim).toBe("pass");
    expect(result.dmarc).toBe("pass");
    expect(result.mx).toBe("pass");
    expect(result.error).toBeUndefined();
  });

  it("returns 4 records array alongside statuses", async () => {
    mockResolveTxt
      .mockImplementation((name: string) => {
        if (name === "example.com") return resolvedTxt([`v=spf1 include:${SPF_INCLUDE} ~all`]);
        if (name.startsWith(`${DKIM_SELECTOR}._domainkey`)) return resolvedTxt(["v=DKIM1; k=rsa; p=ABCD"]);
        if (name.startsWith("_dmarc")) return resolvedTxt(["v=DMARC1; p=none"]);
        return rejectedDns();
      });
    mockResolveMx.mockResolvedValue([{ priority: 10, exchange: "mail.example.com" }]);

    const result = await checkDomainDns("example.com");
    expect(result.records).toHaveLength(4);
    expect(result.records.map((r) => r.purpose).sort()).toEqual(["DKIM", "DMARC", "MX", "SPF"]);
  });
});

// ---------------------------------------------------------------------------
// checkDomainDns — SPF checks
// ---------------------------------------------------------------------------

describe("checkDomainDns — SPF", () => {
  beforeEach(() => {
    mockResolveTxt.mockReset();
    mockResolveMx.mockReset();
    mockResolveMx.mockResolvedValue([]);
    // Default: DKIM and DMARC rejected → fail (not SPF under test)
    mockResolveTxt.mockImplementation((name: string) => {
      if (!name.includes("_domainkey") && !name.startsWith("_dmarc")) return rejectedDns();
      return rejectedDns();
    });
  });

  it("marks SPF pass when the record contains the required include", async () => {
    mockResolveTxt.mockImplementation((name: string) => {
      if (name === "spf-test.com") return resolvedTxt([`v=spf1 include:${SPF_INCLUDE} ~all`]);
      return rejectedDns();
    });

    const result = await checkDomainDns("spf-test.com");
    expect(result.spf).toBe("pass");
  });

  it("marks SPF fail when the required include is missing", async () => {
    mockResolveTxt.mockImplementation((name: string) => {
      if (name === "bad-spf.com") return resolvedTxt(["v=spf1 include:other.com ~all"]);
      return rejectedDns();
    });

    const result = await checkDomainDns("bad-spf.com");
    expect(result.spf).toBe("fail");
  });

  it("marks SPF fail when TXT lookup fails entirely", async () => {
    mockResolveTxt.mockRejectedValue(new Error("ENOTFOUND"));

    const result = await checkDomainDns("no-spf.com");
    expect(result.spf).toBe("fail");
  });

  it("marks SPF fail when no SPF TXT record exists (empty array)", async () => {
    mockResolveTxt.mockImplementation((name: string) => {
      if (name === "empty-spf.com") return resolvedTxt([]);
      return rejectedDns();
    });

    const result = await checkDomainDns("empty-spf.com");
    expect(result.spf).toBe("fail");
  });
});

// ---------------------------------------------------------------------------
// checkDomainDns — DKIM checks
// ---------------------------------------------------------------------------

describe("checkDomainDns — DKIM", () => {
  beforeEach(() => {
    mockResolveTxt.mockReset();
    mockResolveMx.mockReset();
    mockResolveMx.mockResolvedValue([]);
  });

  it("marks DKIM pass when selector TXT record starts with v=DKIM1", async () => {
    mockResolveTxt.mockImplementation((name: string) => {
      if (name === `${DKIM_SELECTOR}._domainkey.dkim-ok.com`) {
        return resolvedTxt(["v=DKIM1; k=rsa; p=MIIBIjANBg..."]);
      }
      return rejectedDns();
    });

    const result = await checkDomainDns("dkim-ok.com");
    expect(result.dkim).toBe("pass");
  });

  it("marks DKIM fail when selector TXT lookup throws", async () => {
    mockResolveTxt.mockRejectedValue(new Error("NXDOMAIN"));
    const result = await checkDomainDns("no-dkim.com");
    expect(result.dkim).toBe("fail");
  });

  it("marks DKIM fail when TXT record does not start with v=DKIM1", async () => {
    mockResolveTxt.mockImplementation((name: string) => {
      if (name.includes("_domainkey")) return resolvedTxt(["not-a-dkim-record"]);
      return rejectedDns();
    });
    const result = await checkDomainDns("bad-dkim.com");
    expect(result.dkim).toBe("fail");
  });
});

// ---------------------------------------------------------------------------
// checkDomainDns — DMARC checks
// ---------------------------------------------------------------------------

describe("checkDomainDns — DMARC", () => {
  beforeEach(() => {
    mockResolveTxt.mockReset();
    mockResolveMx.mockReset();
    mockResolveMx.mockResolvedValue([]);
  });

  it("marks DMARC pass when _dmarc TXT record starts with v=DMARC1", async () => {
    mockResolveTxt.mockImplementation((name: string) => {
      if (name === "_dmarc.dmarc-ok.com") return resolvedTxt(["v=DMARC1; p=none"]);
      return rejectedDns();
    });

    const result = await checkDomainDns("dmarc-ok.com");
    expect(result.dmarc).toBe("pass");
  });

  it("marks DMARC fail when _dmarc TXT lookup throws", async () => {
    mockResolveTxt.mockRejectedValue(new Error("NXDOMAIN"));
    const result = await checkDomainDns("no-dmarc.com");
    expect(result.dmarc).toBe("fail");
  });

  it("marks DMARC fail when record does not start with v=DMARC1", async () => {
    mockResolveTxt.mockImplementation((name: string) => {
      if (name.startsWith("_dmarc")) return resolvedTxt(["some-other-record"]);
      return rejectedDns();
    });
    const result = await checkDomainDns("bad-dmarc.com");
    expect(result.dmarc).toBe("fail");
  });
});

// ---------------------------------------------------------------------------
// checkDomainDns — MX checks
// ---------------------------------------------------------------------------

describe("checkDomainDns — MX", () => {
  beforeEach(() => {
    mockResolveTxt.mockReset();
    mockResolveMx.mockReset();
    mockResolveTxt.mockRejectedValue(new Error("NXDOMAIN"));
  });

  it("marks MX pass when at least one MX record exists", async () => {
    mockResolveMx.mockResolvedValue([{ priority: 10, exchange: "mail.example.com" }]);
    const result = await checkDomainDns("mx-ok.com");
    expect(result.mx).toBe("pass");
  });

  it("marks MX fail when MX lookup returns empty array", async () => {
    mockResolveMx.mockResolvedValue([]);
    const result = await checkDomainDns("no-mx.com");
    expect(result.mx).toBe("fail");
  });

  it("marks MX fail when MX lookup throws", async () => {
    mockResolveMx.mockRejectedValue(new Error("NXDOMAIN"));
    const result = await checkDomainDns("no-mx-throws.com");
    expect(result.mx).toBe("fail");
  });
});

// ---------------------------------------------------------------------------
// checkDomainDns — partial failures (one record fails, others still checked)
// ---------------------------------------------------------------------------

describe("checkDomainDns — partial failures", () => {
  beforeEach(() => {
    mockResolveTxt.mockReset();
    mockResolveMx.mockReset();
  });

  it("succeeds for passing records even when other lookups fail", async () => {
    // Only MX passes; SPF/DKIM/DMARC all rejected
    mockResolveTxt.mockRejectedValue(new Error("NXDOMAIN"));
    mockResolveMx.mockResolvedValue([{ priority: 5, exchange: "fallback.mail.com" }]);

    const result = await checkDomainDns("partial.com");
    expect(result.spf).toBe("fail");
    expect(result.dkim).toBe("fail");
    expect(result.dmarc).toBe("fail");
    expect(result.mx).toBe("pass");
    expect(result.records).toHaveLength(4);
  });

  it("stores the actual resolved values in records when lookup succeeds", async () => {
    const spfValue = `v=spf1 include:${SPF_INCLUDE} ~all`;
    mockResolveTxt.mockImplementation((name: string) => {
      if (name === "recorded.com") return resolvedTxt([spfValue]);
      return rejectedDns();
    });
    mockResolveMx.mockResolvedValue([]);

    const result = await checkDomainDns("recorded.com");
    const spfRecord = result.records.find((r) => r.purpose === "SPF");
    expect(spfRecord!.value).toContain("spf1");
  });

  it("stores placeholder values in records when lookup fails", async () => {
    mockResolveTxt.mockRejectedValue(new Error("NXDOMAIN"));
    mockResolveMx.mockRejectedValue(new Error("NXDOMAIN"));

    const result = await checkDomainDns("all-fail.com");
    const dkimRecord = result.records.find((r) => r.purpose === "DKIM");
    expect(dkimRecord!.value).toContain("PLACEHOLDER");
  });

  it("runs all 4 lookups in parallel (does not short-circuit on first failure)", async () => {
    let callCount = 0;
    mockResolveTxt.mockImplementation(() => {
      callCount++;
      return rejectedDns();
    });
    mockResolveMx.mockImplementation(() => {
      callCount++;
      return rejectedDns();
    });

    await checkDomainDns("parallel-test.com");
    // 3 resolveTxt calls + 1 resolveMx call
    expect(callCount).toBe(4);
  });
});
