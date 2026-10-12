import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  extractObservations,
  fetchUnipileProfile,
  mappingsFor,
  ProviderRequestError,
  readMapping,
  unipileProfilePath,
  UNIPILE_COMPANY_MAPPINGS,
  UNIPILE_PERSON_MAPPINGS,
  type FieldMapping,
  type ProviderTargetType,
} from "./unipile-profile.adapter.js";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "__fixtures__", "unipile");
const LIVE = join(FIXTURES, "live");
const load = (path: string) => JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
const liveFiles = existsSync(LIVE) ? readdirSync(LIVE).filter((name) => name.endsWith(".json")) : [];
const typeOf = (file: string): ProviderTargetType => (file.startsWith("company-") ? "company" : "person");
const ALL: Array<[ProviderTargetType, FieldMapping]> = [
  ...UNIPILE_PERSON_MAPPINGS.map((mapping): [ProviderTargetType, FieldMapping] => ["person", mapping]),
  ...UNIPILE_COMPANY_MAPPINGS.map((mapping): [ProviderTargetType, FieldMapping] => ["company", mapping]),
];

describe("Unipile field map contract (recorded live payloads)", () => {
  it("marks a mapping verified only when a recorded live payload proves its path", () => {
    for (const [targetType, mapping] of ALL) {
      if (mapping.status !== "verified") continue;
      const label = `${targetType}.${mapping.attribute}`;
      expect(mapping.verifiedBy, `${label} is verified but names no live payload`).toBeTruthy();
      expect(liveFiles, `${label} cites ${mapping.verifiedBy}, which is not in __fixtures__/unipile/live`).toContain(mapping.verifiedBy);
      expect(typeOf(mapping.verifiedBy!), `${label} cites a payload of the other target type`).toBe(targetType);
      const value = readMapping(load(join(LIVE, mapping.verifiedBy!)), mapping);
      expect(value === undefined || value === null || value === "", `${label}: ${mapping.path} is empty in ${mapping.verifiedBy}`).toBe(false);
    }
  });

  it("never cites a documentation-derived fixture as proof", () => {
    for (const [, mapping] of ALL) {
      if (mapping.verifiedBy) expect(existsSync(join(FIXTURES, "documented", mapping.verifiedBy))).toBe(false);
    }
  });

  it.each(liveFiles)("reads %s through the field map without promoting contact data", (file) => {
    const extracted = extractObservations(typeOf(file), load(join(LIVE, file)));
    expect(extracted.observations.length).toBeGreaterThan(0);
    for (const observation of extracted.observations) {
      if (observation.contactData) expect(observation.promotable).toBe(false);
    }
  });
});

describe("extractObservations", () => {
  const documented = load(join(FIXTURES, "documented", "person-profile.json"));

  it("keeps every unverified mapping as an observation and promotes nothing", () => {
    const extracted = extractObservations("person", documented);
    expect(extracted.promotable).toEqual({});
    expect(extracted.observations.map((observation) => observation.attribute)).toEqual(
      expect.arrayContaining(["fullName", "headline", "experience", "emails", "phones"])
    );
    expect(extracted.observations.every((observation) => !observation.promotable)).toBe(true);
    // Observations name fields; they do not carry the values out of the raw response.
    expect(JSON.stringify(extracted.observations)).not.toContain("example.person@example.invalid");
  });

  it("promotes a verified mapping and still never promotes contact data", () => {
    const mappings: FieldMapping[] = [
      { attribute: "headline", path: "description", status: "verified", verifiedBy: "person-x.json" },
      { attribute: "emails", path: "emails", status: "verified", verifiedBy: "person-x.json", contactData: true },
      { attribute: "summary", path: "bio", status: "unverified" },
    ];
    const extracted = extractObservations("person", documented, mappings);
    expect(extracted.promotable).toEqual({ headline: "Head of Revenue at Example Co" });
    expect(extracted.observations.find((observation) => observation.attribute === "emails")?.promotable).toBe(false);
  });

  it("reports a missing field as absent and fills nothing in", () => {
    const extracted = extractObservations("person", { first_name: "Example", description: "  " });
    expect(extracted.observations.map((observation) => observation.attribute)).toEqual(["fullName"]);
    expect(extracted.absent).toEqual(expect.arrayContaining(["headline", "emails", "phones", "experience"]));
    expect(extracted.promotable).toEqual({});
  });

  it("has a field map for both target types", () => {
    expect(mappingsFor("person")).toBe(UNIPILE_PERSON_MAPPINGS);
    expect(mappingsFor("company")).toBe(UNIPILE_COMPANY_MAPPINGS);
  });
});

describe("fetchUnipileProfile", () => {
  const request = { baseUrl: "https://unipile.invalid/", apiKey: "server-side-key", accountId: "acc 1", targetType: "person" as const, identifier: "jane-doe", timeoutMs: 1000 };
  const respond = (status: number, body: string, headers: Record<string, string> = {}) =>
    (async () => new Response(body, { status, headers })) as unknown as typeof fetch;

  it("requests the v2 profile path with the key in a header, not the URL", async () => {
    let seen: { url: string; headers: Record<string, string> } | undefined;
    const fetchImpl = (async (url: string, init: RequestInit) => {
      seen = { url, headers: init.headers as Record<string, string> };
      return new Response(JSON.stringify({ first_name: "Jane" }), { status: 200 });
    }) as unknown as typeof fetch;
    const response = await fetchUnipileProfile({ ...request, fetchImpl });
    expect(seen!.url).toBe(`https://unipile.invalid${unipileProfilePath("person", "acc 1", "jane-doe")}`);
    expect(seen!.url).toContain("/v2/acc%201/users/jane-doe?with_sections=");
    expect(seen!.url).not.toContain("server-side-key");
    expect(seen!.headers["X-API-KEY"]).toBe("server-side-key");
    expect(response.payload).toEqual({ first_name: "Jane" });
    expect(response.requestPath).not.toContain("server-side-key");
    expect(response.payloadHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("uses the company path for a company", () => {
    expect(unipileProfilePath("company", "acc", "initech")).toBe("/v2/acc/linkedin/company/initech");
  });

  it.each([
    [401, "credential_rejected", false],
    [403, "account_unavailable", false],
    [404, "not_found", false],
    [422, "invalid_response", false],
    [429, "rate_limited", true],
    [503, "transient", true],
  ])("classifies HTTP %i as %s", async (status, kind, retryable) => {
    const error = await fetchUnipileProfile({ ...request, fetchImpl: respond(status, "{}") }).catch((caught) => caught);
    expect(error).toBeInstanceOf(ProviderRequestError);
    expect(error.kind).toBe(kind);
    expect(error.retryable).toBe(retryable);
  });

  it("honours Retry-After on a rate limit", async () => {
    const error = await fetchUnipileProfile({ ...request, fetchImpl: respond(429, "{}", { "retry-after": "120" }) }).catch((caught) => caught);
    expect(error.retryAfterMs).toBe(120_000);
  });

  it("treats a network failure as retryable and a non-object body as invalid", async () => {
    const down = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    expect((await fetchUnipileProfile({ ...request, fetchImpl: down }).catch((caught) => caught)).kind).toBe("transient");
    expect((await fetchUnipileProfile({ ...request, fetchImpl: respond(200, "[]") }).catch((caught) => caught)).kind).toBe("invalid_response");
    expect((await fetchUnipileProfile({ ...request, fetchImpl: respond(200, "<html>") }).catch((caught) => caught)).kind).toBe("invalid_response");
  });
});
