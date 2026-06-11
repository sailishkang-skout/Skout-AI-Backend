import { createHash } from "node:crypto";
import { generateEmailCandidates } from "../email-patterns.js";
import type {
  CompanyData,
  EmailFinder,
  EmailVerification,
  EmailVerifier,
  FirmographicsProvider,
  FoundEmail,
  PhoneData,
  PhoneProvider,
  ProviderRegistry,
} from "../types.js";

/**
 * Stub adapters — deterministic, key-free implementations used in local dev,
 * tests, and CI. They mirror the real provider shapes (RevenueBase / PDL /
 * MillionVerifier / ZeroBounce / Datagma) so swapping in live adapters is a
 * drop-in. Swap these out via PAL config when API keys are present.
 */

function hashInt(...parts: string[]): number {
  const h = createHash("sha256").update(parts.join("|")).digest("hex");
  return parseInt(h.slice(0, 8), 16);
}

const INDUSTRIES = ["Software", "Financial Services", "Healthcare", "Retail", "Manufacturing"];
const COUNTRIES = ["US", "CA", "GB", "AU", "IN"];
const CITIES = ["San Francisco", "New York", "Toronto", "London", "Sydney"];

export class StubFirmographics implements FirmographicsProvider {
  readonly name = "stub-firmographics";
  async fetchCompany(domain: string, name?: string): Promise<CompanyData | null> {
    const seed = hashInt(domain);
    return {
      companyName: name ?? domain.split(".")[0].replace(/^\w/, (c) => c.toUpperCase()),
      industry: INDUSTRIES[seed % INDUSTRIES.length],
      employeeCount: 25 + (seed % 40) * 25,
      annualRevenue: (5 + (seed % 50)) * 1_000_000,
      hqCountry: COUNTRIES[seed % COUNTRIES.length],
      hqCity: CITIES[seed % CITIES.length],
      foundedDate: `${2000 + (seed % 24)}-01-01`,
    };
  }
}

export class StubEmailFinder implements EmailFinder {
  readonly name = "stub-hunter";
  async findEmail(fullName: string, domain: string): Promise<FoundEmail | null> {
    const [best] = generateEmailCandidates(fullName, domain);
    if (!best) return null;
    const seed = hashInt(fullName, domain);
    return { email: best, confidence: 0.6 + (seed % 35) / 100 };
  }
}

export class StubEmailVerifier implements EmailVerifier {
  readonly name = "stub-verifier";
  async verify(email: string): Promise<EmailVerification> {
    const seed = hashInt(email) % 100;
    if (seed < 70) return { status: "valid", deliverabilityScore: 90 + (seed % 10), catchAll: false, risky: false };
    if (seed < 85) return { status: "catch_all", deliverabilityScore: 55 + (seed % 10), catchAll: true, risky: false };
    if (seed < 95) return { status: "risky", deliverabilityScore: 35 + (seed % 10), catchAll: false, risky: true };
    return { status: "invalid", deliverabilityScore: 5 + (seed % 10), catchAll: false, risky: true };
  }
}

export class StubPhoneProvider implements PhoneProvider {
  readonly name = "stub-datagma";
  async fetchPhone(fullName: string, domain: string): Promise<PhoneData | null> {
    const seed = hashInt(fullName, domain);
    if (seed % 5 === 0) return null; // ~20% miss, like real providers
    const n = (seed % 9_000_000) + 1_000_000;
    return { mobile: `+1415${String(n).padStart(7, "0")}` };
  }
}

export function createStubRegistry(): ProviderRegistry {
  return {
    firmographics: [new StubFirmographics()],
    emailFinders: [new StubEmailFinder()],
    emailVerifiers: [new StubEmailVerifier()],
    phone: [new StubPhoneProvider()],
  };
}
