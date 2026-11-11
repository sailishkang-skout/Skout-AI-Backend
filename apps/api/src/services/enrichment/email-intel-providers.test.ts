// cSpell:ignore skout
import { afterEach, describe, expect, it, vi } from "vitest";
import { createStubRegistry, EnrichmentEngine, type EmailVerifier } from "@skout/pal";
import { EmailIntelFinder, EmailIntelVerifier, withEmailIntel } from "./email-intel-providers.js";

const cfg = { EMAIL_INTEL_SERVICE_URL: "https://ei.test", EMAIL_INTEL_TIMEOUT_MS: 1000, EMAIL_INTEL_DISCOVER_TIMEOUT_MS: 1000 };
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });
const verifyBody = (status: string, extra: Record<string, unknown> = {}) => ({
  success: true,
  email: "a@acme.com",
  domain: "acme.com",
  disposable: false,
  verificationStatus: { status },
  sendEligibility: { allowed: true, decision: "ALLOW", decisionConfidence: 88 },
  ...extra,
});

afterEach(() => vi.restoreAllMocks());

describe("EmailIntelVerifier", () => {
  it("maps a conclusive email-intel status to a PAL verdict", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => json(verifyBody("VERIFIED")));
    expect(await new EmailIntelVerifier(cfg).verify("A@Acme.com")).toEqual({
      status: "valid",
      deliverabilityScore: 88,
      catchAll: false,
      risky: false,
    });
  });

  it("maps INVALID and CATCH_ALL", async () => {
    const spy = vi.spyOn(globalThis, "fetch");
    spy.mockImplementationOnce(async () => json(verifyBody("INVALID")));
    expect((await new EmailIntelVerifier(cfg).verify("a@acme.com")).status).toBe("invalid");
    spy.mockImplementationOnce(async () => json(verifyBody("CATCH_ALL", { catchAll: true })));
    expect(await new EmailIntelVerifier(cfg).verify("a@acme.com")).toMatchObject({ status: "catch_all", catchAll: true, risky: true });
  });

  it.each(["SMTP_ERROR", "DNS_ERROR", "NO_MX"])("throws on %s so the next provider is tried", async (status) => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => json(verifyBody(status)));
    await expect(new EmailIntelVerifier(cfg).verify("a@gmail.com")).rejects.toThrow(/inconclusive/);
  });

  it("throws when the service is down", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("boom", { status: 503 }));
    await expect(new EmailIntelVerifier(cfg).verify("a@acme.com")).rejects.toThrow();
  });
});

describe("EmailIntelFinder", () => {
  const discovery = (decision: string, email = "ada.lovelace@acme.com", confidence = 92) => ({
    success: true,
    recommendedEmail: email,
    candidates: [{ email, pattern: "first.last", finalScore: 1, decision, confidence, reasons: [] }],
  });

  it("returns a STRONG/GOOD candidate with 0-1 confidence and asks for verification", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => json(discovery("STRONG")));
    expect(await new EmailIntelFinder(cfg).findEmail("Ada Lovelace", "acme.com")).toEqual({
      email: "ada.lovelace@acme.com",
      confidence: 0.92,
    });
    const [url, init] = spy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://ei.test/email-discovery");
    expect(JSON.parse(String(init.body))).toMatchObject({ firstName: "ada", lastName: "lovelace", domain: "acme.com", verify: true });
  });

  it("returns null for weak candidates and for candidates on another domain", async () => {
    const spy = vi.spyOn(globalThis, "fetch");
    spy.mockImplementationOnce(async () => json(discovery("WEAK")));
    expect(await new EmailIntelFinder(cfg).findEmail("Ada Lovelace", "acme.com")).toBeNull();
    spy.mockImplementationOnce(async () => json(discovery("STRONG", "ada@other.com")));
    expect(await new EmailIntelFinder(cfg).findEmail("Ada Lovelace", "acme.com")).toBeNull();
  });

  it("makes no call for LinkedIn-only prospects (placeholder domain)", async () => {
    const spy = vi.spyOn(globalThis, "fetch");
    expect(await new EmailIntelFinder(cfg).findEmail("Ada Lovelace", "linkedin-capture.local")).toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("withEmailIntel", () => {
  it("puts email-intel first when configured, keeping existing providers as fallbacks", () => {
    const reg = withEmailIntel(createStubRegistry(), cfg as never);
    expect(reg.emailFinders[0]!.name).toBe("email-intel");
    expect(reg.emailVerifiers[0]!.name).toBe("email-intel");
    expect(reg.emailFinders.length).toBeGreaterThan(1);
  });

  it("leaves the registry untouched when email-intel is not configured", () => {
    const base = createStubRegistry();
    const before = base.emailFinders.length;
    expect(withEmailIntel(base, { ...cfg, EMAIL_INTEL_SERVICE_URL: undefined } as never).emailFinders).toHaveLength(before);
  });
});

describe("inside the enrichment engine", () => {
  const fallback: EmailVerifier & { calls: number } = {
    name: "fallback",
    calls: 0,
    async verify() {
      this.calls++;
      return { status: "valid", deliverabilityScore: 70, catchAll: false, risky: false };
    },
  };
  const engineWith = () => {
    fallback.calls = 0;
    const reg = createStubRegistry();
    reg.emailVerifiers = [new EmailIntelVerifier(cfg), fallback];
    return new EnrichmentEngine(reg, {});
  };
  const input = { prospectId: "p", companyDomain: "acme.com", fullName: "Ada Lovelace", email: "ada@acme.com", fields: ["validation" as const] };

  it("falls through to the next verifier when email-intel is inconclusive", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => json(verifyBody("SMTP_ERROR")));
    const out = await engineWith().enrich(input);
    expect(fallback.calls).toBe(1);
    expect(out.results.find((r) => r.field === "email_status")).toMatchObject({ provider: "fallback", value: "valid" });
    expect(out.attempts.find((a) => a.provider === "email-intel")).toMatchObject({ status: "error" });
  });

  it("stops at email-intel when it gives a conclusive verdict", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => json(verifyBody("INVALID")));
    const out = await engineWith().enrich(input);
    expect(fallback.calls).toBe(0);
    expect(out.results.find((r) => r.field === "email_status")).toMatchObject({ provider: "email-intel", value: "invalid" });
  });
});
