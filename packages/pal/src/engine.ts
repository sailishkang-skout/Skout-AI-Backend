import { createStubRegistry } from "./adapters/stub.js";
import { generateEmailCandidates } from "./email-patterns.js";
import {
  PHONE_SCORE_GATE,
  type AttemptLog,
  type EnrichField,
  type CompanyData,
  type EnrichmentInput,
  type EnrichmentOutcome,
  type FieldResult,
  type ProviderRegistry,
} from "./types.js";

const DEFAULT_FIELDS: EnrichField[] = ["company", "email", "validation"];

/**
 * EnrichmentEngine — the PAL waterfall (strategy §8 Tier 2).
 *
 *   internal_graph (cache, caller-supplied) → firmographics → find email →
 *   verify email (store only if valid) → phone (gated on lead score > 80)
 *
 * Pure: takes input + provider registry, returns structured field results and
 * a per-step attempt log. The API layer persists results to PostgreSQL and
 * deducts credits based on `creditsUsed`.
 */
export interface EnrichmentEngineOptions {
  /** Phone enrichment only runs when lead score exceeds this (default 80). */
  phoneScoreGate?: number;
}

export class EnrichmentEngine {
  private readonly phoneScoreGate: number;

  constructor(
    private readonly providers: ProviderRegistry = createStubRegistry(),
    options: EnrichmentEngineOptions = {}
  ) {
    this.phoneScoreGate = options.phoneScoreGate ?? PHONE_SCORE_GATE;
  }

  async enrich(input: EnrichmentInput): Promise<EnrichmentOutcome> {
    const fields = input.fields ?? DEFAULT_FIELDS;
    const results: FieldResult[] = [];
    const attempts: AttemptLog[] = [];
    let order = 0;
    let creditsUsed = 0;

    const run = async <T>(
      provider: string,
      operation: string,
      fn: () => Promise<T | null>
    ): Promise<T | null> => {
      const started = Date.now();
      order += 1;
      try {
        const value = await fn();
        attempts.push({
          order,
          provider,
          operation,
          status: value == null ? "miss" : "ok",
          latencyMs: Date.now() - started,
        });
        return value;
      } catch (err) {
        attempts.push({
          order,
          provider,
          operation,
          status: "error",
          latencyMs: Date.now() - started,
          detail: err instanceof Error ? err.message : String(err),
        });
        return null;
      }
    };

    // 1. Firmographics
    if (fields.includes("company")) {
      for (const p of this.providers.firmographics) {
        const company = await run(p.name, "fetchCompany", () =>
          p.fetchCompany(input.companyDomain, input.companyName)
        );
        if (company) {
          results.push({ field: "company", valueJson: company, provider: p.name, isPrimary: true });
          creditsUsed += 1;
          break;
        }
      }
    }

    // 2. Email — use supplied, else find, else first generated candidate
    let email = input.email;
    if (!email && fields.includes("email") && input.fullName) {
      for (const p of this.providers.emailFinders) {
        const found = await run(p.name, "findEmail", () =>
          p.findEmail(input.fullName!, input.companyDomain)
        );
        if (found) {
          email = found.email;
          results.push({ field: "email", value: email, provider: p.name, confidence: found.confidence });
          creditsUsed += 1;
          break;
        }
      }
      if (!email) {
        const [candidate] = generateEmailCandidates(input.fullName, input.companyDomain);
        if (candidate) {
          email = candidate;
          results.push({ field: "email", value: email, provider: "pattern-gen", confidence: 0.4 });
        }
      }
    }

    // 3. Validation — verified-only rule: mark email primary only if it passes
    if (email && fields.includes("validation")) {
      for (const p of this.providers.emailVerifiers) {
        const verdict = await run(p.name, "verify", () => p.verify(email!));
        if (verdict) {
          creditsUsed += 1;
          const passes = verdict.status === "valid";
          results.push({
            field: "email_status",
            value: verdict.status,
            valueJson: verdict,
            provider: p.name,
            validationStatus: verdict.status,
          });
          // Promote the email to primary only when verified valid.
          const emailResult = results.find((r) => r.field === "email");
          if (emailResult) emailResult.isPrimary = passes;
          if (!passes) {
            attempts.push({
              order: ++order,
              provider: p.name,
              operation: "gate",
              status: "skipped",
              latencyMs: 0,
              detail: `email not promoted (status=${verdict.status})`,
            });
          }
          break;
        }
      }
    }

    // 4. Phone — gated on lead score > 80 (strategy §6)
    if (fields.includes("phone")) {
      const companyData = results.find((r) => r.field === "company")?.valueJson as
        | CompanyData
        | undefined;
      const score = input.resolveLeadScoreForPhone
        ? await input.resolveLeadScoreForPhone(companyData)
        : (input.leadScore ?? 0);

      if (score <= this.phoneScoreGate) {
        attempts.push({
          order: ++order,
          provider: "phone-gate",
          operation: "score-gate",
          status: "skipped",
          latencyMs: 0,
          detail: `lead score ${score} <= ${this.phoneScoreGate}`,
        });
        results.push({
          field: "phone",
          provider: "phone-gate",
          validationStatus: "skipped",
          valueJson: {
            reason: `Lead score ${score} must be above ${this.phoneScoreGate} for phone lookup`,
            leadScore: score,
            gate: this.phoneScoreGate,
          },
        });
      } else if (!input.fullName) {
        attempts.push({
          order: ++order,
          provider: "phone-gate",
          operation: "name-gate",
          status: "skipped",
          latencyMs: 0,
          detail: "full name required",
        });
        results.push({
          field: "phone",
          provider: "phone-gate",
          validationStatus: "skipped",
          valueJson: { reason: "Full name is required for phone lookup" },
        });
      } else {
        for (const p of this.providers.phone) {
          const phone = await run(p.name, "fetchPhone", () =>
            p.fetchPhone(input.fullName!, input.companyDomain, input.linkedinUrl, email)
          );
          if (phone) {
            results.push({
              field: "phone",
              valueJson: phone,
              value: phone.mobile ?? phone.direct,
              provider: p.name,
              isPrimary: true,
            });
            creditsUsed += 1;
            break;
          }
        }
        const phoneError = attempts.find(
          (a) => a.operation === "fetchPhone" && a.status === "error"
        );
        if (!results.some((r) => r.field === "phone" && r.isPrimary) && phoneError) {
          results.push({
            field: "phone",
            provider: phoneError.provider,
            validationStatus: "error",
            valueJson: { reason: phoneError.detail ?? "Phone lookup failed" },
          });
        }
      }
    }

    return { prospectId: input.prospectId, results, attempts, creditsUsed };
  }
}
