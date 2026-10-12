import { describe, expect, it } from "vitest";
import {
  claimsInCopy,
  composeRecipientClaims,
  defaultDraft,
  draftFingerprint,
  draftProblems,
  OPENING_TOKEN,
  recipientFingerprint,
  renderBody,
  type Claim,
} from "./campaign-composer.js";
import type { EvidenceFact } from "./research.service.js";

let counter = 0;
const fact = (attribute: string, value: unknown, overrides: Partial<EvidenceFact> = {}): EvidenceFact => ({
  evidenceId: `ev-${++counter}`,
  attribute,
  value,
  source: "linkedin_public_profile",
  sourceUrl: "https://www.linkedin.com/in/priya-raman/",
  observedAt: "2026-10-06T09:00:00.000Z",
  capturedAt: "2026-10-06T09:00:00.000Z",
  confidence: 0.9,
  state: "verified",
  method: "extension_rendered_dom",
  freshnessExpiresAt: "2027-01-04T09:00:00.000Z",
  stale: false,
  usableForClaims: true,
  ...overrides,
});
const employment = (overrides: Partial<EvidenceFact> = {}) => fact("employment", { companyName: "Initech", title: "Head of Revenue" }, overrides);
const companyFacts = () => [
  fact("industry", "Software Development", { source: "linkedin_company_page", confidence: 0.85 }),
  fact("specialties", ["Revenue Operations", "Analytics", "Forecasting"], { source: "linkedin_company_page" }),
  fact("size", "201-500 employees", { source: "linkedin_company_page" }),
  fact("overview", "A long description that is never turned into a claim.", { source: "linkedin_company_page" }),
];
const compose = (personFacts: EvidenceFact[], company = companyFacts(), jobChange = false) =>
  composeRecipientClaims({ personFacts, companyFacts: company, companyName: "Initech", jobChange });
const all = (claims: ReturnType<typeof compose>): Claim[] => [...(claims.reason ? [claims.reason] : []), ...claims.talkingPoints, ...claims.flagged];

describe("composeRecipientClaims", () => {
  it("words each claim from exactly one evidence fact and carries its reference", () => {
    const person = [employment(), fact("headline", "Head of Revenue at Initech")];
    const company = companyFacts();
    const claims = compose(person, company);
    const known = new Map([...person, ...company].map((entry) => [entry.evidenceId, entry]));
    expect(all(claims).length).toBeGreaterThanOrEqual(3);
    for (const claim of all(claims)) {
      const source = known.get(claim.evidenceId);
      expect(source, `claim "${claim.text}" has no evidence`).toBeTruthy();
      expect(claim).toMatchObject({ attribute: source!.attribute, source: source!.source, capturedAt: source!.capturedAt, confidence: source!.confidence, state: source!.state });
    }
    expect(claims.reason!.text).toBe("I saw that you're Head of Revenue at Initech.");
    expect(claims.talkingPoints.map((claim) => claim.text)).toEqual(["Initech is listed under Software Development.", "Initech lists Revenue Operations and Analytics among its specialties."]);
    expect(claims.opening).toBe("I saw that you're Head of Revenue at Initech. Initech is listed under Software Development.");
    expect(claimsInCopy(claims).map((claim) => claim.attribute)).toEqual(["employment", "industry"]);
  });

  it("produces no claim when there is no evidence", () => {
    expect(compose([], [])).toEqual({ reason: null, talkingPoints: [], flagged: [], opening: "" });
    expect(compose([fact("headline", "Head of Revenue at Initech")])).toMatchObject({ reason: null, opening: "" });
    // A fact without the value the sentence needs yields no sentence.
    expect(compose([fact("employment", { title: "Head of Revenue" })]).reason).toBeNull();
  });

  it("excludes discovery-only and stale evidence from copy and flags it with the reason", () => {
    const discovery = compose([employment({ state: "discovery", usableForClaims: false, source: "sales_navigator_search_result", confidence: 0.5 })]);
    expect(discovery.reason).toBeNull();
    expect(discovery.opening).toBe("");
    // Company facts are not attached to someone whose employer is unconfirmed.
    expect(discovery.talkingPoints).toEqual([]);
    expect(discovery.flagged).toHaveLength(1);
    expect(discovery.flagged[0]).toMatchObject({ kind: "role", usable: false, excludedReason: "discovery_only" });
    expect(claimsInCopy(discovery)).toEqual([]);

    const stale = compose([employment({ stale: true, usableForClaims: false })]);
    expect(stale.flagged[0]).toMatchObject({ excludedReason: "stale" });
    expect(stale.opening).toBe("");

    const staleCompany = compose([employment()], [fact("industry", "Software", { stale: true, usableForClaims: false }), fact("size", "11-50 employees")]);
    expect(staleCompany.talkingPoints.map((claim) => claim.attribute)).toEqual(["size"]);
    expect(staleCompany.flagged.map((claim) => claim.attribute)).toEqual(["industry"]);
    expect(staleCompany.opening).not.toContain("Software");
  });

  it("words a job change as a job change, on the same evidence", () => {
    const claims = compose([employment()], [], true);
    expect(claims.reason).toMatchObject({ kind: "job_change", attribute: "employment" });
    expect(claims.reason!.text).toBe("I saw that you recently moved into the Head of Revenue role at Initech.");
  });

  it("does not carry page markup or multi-line text into copy", () => {
    const claims = compose([fact("employment", { companyName: "Initech\n<script>", title: "Head {{of}} Revenue" })], []);
    expect(claims.reason!.text).toBe("I saw that you're Head of Revenue at Initech script.");
    const long = compose([fact("employment", { companyName: "x".repeat(200), title: "Head" })], []);
    expect(long.reason).toBeNull();
  });
});

describe("draft copy", () => {
  it("starts with copy that states nothing about the recipient outside the opening", () => {
    const draft = defaultDraft(false);
    expect(draft.steps).toHaveLength(3);
    expect(draft.steps[0]!.body).toContain(OPENING_TOKEN);
    expect(draft.steps.slice(1).some((step) => step.body.includes(OPENING_TOKEN))).toBe(false);
    expect(draftProblems(draft).join(" ")).toMatch(/Step 1 still contains placeholder text/);
    expect(defaultDraft(true).steps[0]!.subject).toMatch(/new role/);
  });

  it("puts the opening where the token is and drops the paragraph when there is none", () => {
    const body = `Hi {{firstName}},\n\n${OPENING_TOKEN}\n\nWe help revenue teams.`;
    expect(renderBody(body, "I saw that you're at Initech.")).toBe("Hi {{firstName}},\n\nI saw that you're at Initech.\n\nWe help revenue teams.");
    expect(renderBody(body, "")).toBe("Hi {{firstName}},\n\nWe help revenue teams.");
    expect(renderBody("No token here.", "ignored")).toBe("No token here.");
  });

  it("changes the fingerprint when the copy, the address or the evidence behind a claim changes", () => {
    const base = compose([employment()], []);
    const print = recipientFingerprint("p1", "a@initech.example", base);
    expect(recipientFingerprint("p1", "A@Initech.example", base)).toBe(print);
    expect(recipientFingerprint("p1", "b@initech.example", base)).not.toBe(print);
    expect(recipientFingerprint("p1", "a@initech.example", compose([fact("employment", { companyName: "Initech", title: "CRO" })], []))).not.toBe(print);
    expect(recipientFingerprint("p1", "a@initech.example", compose([employment({ stale: true, usableForClaims: false })], []))).not.toBe(print);

    const draft = defaultDraft(false);
    const edited = { ...draft, steps: draft.steps.map((step, index) => (index === 1 ? { ...step, body: `${step.body} PS` } : step)) };
    expect(draftFingerprint(edited)).not.toBe(draftFingerprint(draft));
    expect(draftFingerprint(defaultDraft(false))).toBe(draftFingerprint(draft));
  });
});
