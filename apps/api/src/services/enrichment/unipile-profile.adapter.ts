import { createHash } from "node:crypto";

/**
 * ENR-04 — Unipile API v2 adapter for LinkedIn person and company profiles.
 *
 * The adapter does two separate things:
 *   1. `fetchUnipileProfile` retrieves the provider's response. The whole response is kept by
 *      the caller as evidence (`enrichment_attempts.response_output`).
 *   2. `extractObservations` reads named fields out of that response through the field map
 *      below.
 *
 * Every entry in the field map carries a status. Only a "verified" entry — one that a recorded
 * live payload in `__fixtures__/unipile/live/` exercises, checked by the contract test — may be
 * written to the Evidence Ledger. An "unverified" entry is reported on the job as an
 * observation and goes no further. Contact details are never promotable: the provider states
 * no verification status for them.
 */

export type ProviderTargetType = "person" | "company";

export type ProviderErrorKind =
  | "credential_rejected"
  | "account_unavailable"
  | "not_found"
  | "rate_limited"
  | "transient"
  | "invalid_response";

export class ProviderRequestError extends Error {
  constructor(
    readonly kind: ProviderErrorKind,
    message: string,
    readonly status: number | null = null,
    /** Set from a Retry-After header when the provider sends one. */
    readonly retryAfterMs: number | null = null
  ) {
    super(message);
    this.name = "ProviderRequestError";
  }

  /** Worth another attempt later; everything else needs a person or will never succeed. */
  get retryable(): boolean {
    return this.kind === "rate_limited" || this.kind === "transient";
  }
}

export interface UnipileProfileRequest {
  baseUrl: string;
  apiKey: string;
  accountId: string;
  targetType: ProviderTargetType;
  /** LinkedIn public identifier: the `/in/<id>` or `/company/<id>` slug. */
  identifier: string;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
}

export interface UnipileProfileResponse {
  /** Path only — never the key, never the host credentials. */
  requestPath: string;
  status: number;
  payload: Record<string, unknown>;
  payloadHash: string;
  latencyMs: number;
}

const MAX_RESPONSE_BYTES = 2_000_000;
const MAX_RETRY_AFTER_MS = 60 * 60 * 1000;

/** Sections requested for a person: previews of everything, full experience and skills. */
const PERSON_SECTIONS = ["linkedin_*_preview", "linkedin_experience", "linkedin_skills"];

export function unipileProfilePath(targetType: ProviderTargetType, accountId: string, identifier: string): string {
  const account = encodeURIComponent(accountId);
  const id = encodeURIComponent(identifier);
  if (targetType === "company") return `/v2/${account}/linkedin/company/${id}`;
  const sections = PERSON_SECTIONS.map((section) => `with_sections=${encodeURIComponent(section)}`).join("&");
  return `/v2/${account}/users/${id}?${sections}`;
}

function retryAfterMs(header: string | null): number | null {
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, MAX_RETRY_AFTER_MS);
  const date = Date.parse(header);
  if (Number.isNaN(date)) return null;
  return Math.min(Math.max(date - Date.now(), 0), MAX_RETRY_AFTER_MS);
}

export function hashPayload(payload: unknown): string {
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

export async function fetchUnipileProfile(request: UnipileProfileRequest): Promise<UnipileProfileResponse> {
  const requestPath = unipileProfilePath(request.targetType, request.accountId, request.identifier);
  const doFetch = request.fetchImpl ?? fetch;
  const startedAt = Date.now();

  let res: Response;
  try {
    res = await doFetch(`${request.baseUrl.replace(/\/$/, "")}${requestPath}`, {
      method: "GET",
      headers: { accept: "application/json", "X-API-KEY": request.apiKey },
      signal: AbortSignal.timeout(request.timeoutMs),
    });
  } catch (error) {
    const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
    throw new ProviderRequestError("transient", timedOut ? "The provider did not answer in time." : "The provider could not be reached.");
  }

  if (!res.ok) {
    // The body of an error response is not kept: it can echo request details.
    await res.arrayBuffer().catch(() => undefined);
    if (res.status === 401) throw new ProviderRequestError("credential_rejected", "The provider rejected the server-side credential.", 401);
    if (res.status === 403) throw new ProviderRequestError("account_unavailable", "The connected provider account is not allowed to read this profile.", 403);
    if (res.status === 404) throw new ProviderRequestError("not_found", "The provider has no profile for this LinkedIn URL.", 404);
    if (res.status === 429) {
      throw new ProviderRequestError("rate_limited", "The provider is rate limiting this account.", 429, retryAfterMs(res.headers.get("retry-after")));
    }
    if (res.status >= 500) throw new ProviderRequestError("transient", `The provider returned ${res.status}.`, res.status);
    throw new ProviderRequestError("invalid_response", `The provider refused the request (${res.status}).`, res.status);
  }

  const text = await res.text();
  if (text.length > MAX_RESPONSE_BYTES) {
    throw new ProviderRequestError("invalid_response", "The provider response was larger than expected and was not stored.", res.status);
  }
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new ProviderRequestError("invalid_response", "The provider response was not JSON.", res.status);
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new ProviderRequestError("invalid_response", "The provider response was not a profile object.", res.status);
  }
  return {
    requestPath,
    status: res.status,
    payload: payload as Record<string, unknown>,
    payloadHash: hashPayload(payload),
    latencyMs: Date.now() - startedAt,
  };
}

// ── Field map ────────────────────────────────────────────────────────────────

export type MappingStatus = "verified" | "unverified";

export interface FieldMapping {
  /** Attribute name used by capture evidence, so provider and capture facts line up. */
  attribute: string;
  /** Dot path into the provider payload; `a+b` joins two string fields with a space. */
  path: string;
  status: MappingStatus;
  /**
   * Name of the recorded live payload (under `__fixtures__/unipile/live/`) that proves this
   * path. Required for "verified"; the contract test fails without it.
   */
  verifiedBy?: string;
  /** Contact details: reported, never written to the ledger or to a contact record. */
  contactData?: boolean;
}

/** Bump when a mapping changes, so stored observations can be told apart. */
export const UNIPILE_MAPPING_VERSION = "2026-10-12.1";

/**
 * Paths follow Unipile's published v2 field names. None has been checked against a live
 * payload yet, so none is "verified".
 */
export const UNIPILE_PERSON_MAPPINGS: readonly FieldMapping[] = [
  { attribute: "fullName", path: "first_name+last_name", status: "unverified" },
  { attribute: "headline", path: "description", status: "unverified" },
  { attribute: "summary", path: "bio", status: "unverified" },
  { attribute: "locationName", path: "location", status: "unverified" },
  { attribute: "linkedinUrl", path: "profile_url", status: "unverified" },
  { attribute: "publicId", path: "public_identifier", status: "unverified" },
  { attribute: "connectionsCount", path: "relations_count", status: "unverified" },
  { attribute: "followersCount", path: "followers_count", status: "unverified" },
  { attribute: "experience", path: "specifics.experience", status: "unverified" },
  { attribute: "educations", path: "specifics.education", status: "unverified" },
  { attribute: "skills", path: "specifics.skills", status: "unverified" },
  { attribute: "emails", path: "emails", status: "unverified", contactData: true },
  { attribute: "phones", path: "phone_numbers", status: "unverified", contactData: true },
];

export const UNIPILE_COMPANY_MAPPINGS: readonly FieldMapping[] = [
  { attribute: "name", path: "name", status: "unverified" },
  { attribute: "description", path: "description", status: "unverified" },
  { attribute: "website", path: "website", status: "unverified" },
  { attribute: "industry", path: "industry", status: "unverified" },
  { attribute: "employeeCount", path: "employee_count", status: "unverified" },
  { attribute: "headquarters", path: "locations", status: "unverified" },
  { attribute: "linkedinUrl", path: "profile_url", status: "unverified" },
];

export function mappingsFor(targetType: ProviderTargetType): readonly FieldMapping[] {
  return targetType === "person" ? UNIPILE_PERSON_MAPPINGS : UNIPILE_COMPANY_MAPPINGS;
}

function readPath(payload: unknown, path: string): unknown {
  let current: unknown = payload;
  for (const key of path.split(".")) {
    if (!current || typeof current !== "object" || Array.isArray(current)) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

function isBlank(value: unknown): boolean {
  return (
    value === undefined ||
    value === null ||
    (typeof value === "string" && value.trim() === "") ||
    (Array.isArray(value) && value.length === 0)
  );
}

export function readMapping(payload: unknown, mapping: FieldMapping): unknown {
  if (!mapping.path.includes("+")) {
    const value = readPath(payload, mapping.path);
    return typeof value === "string" ? value.trim() : value;
  }
  const parts = mapping.path
    .split("+")
    .map((part) => readPath(payload, part))
    .filter((part): part is string => typeof part === "string" && part.trim() !== "")
    .map((part) => part.trim());
  return parts.length ? parts.join(" ") : undefined;
}

export interface ProviderObservation {
  attribute: string;
  path: string;
  mappingStatus: MappingStatus;
  contactData: boolean;
  /** True when the value may be written to the Evidence Ledger. */
  promotable: boolean;
}

export interface ExtractedObservations {
  mappingVersion: string;
  /** Verified, non-contact values, keyed by attribute — the only values that leave the job. */
  promotable: Record<string, unknown>;
  /** What was found, without the values, for the job result. */
  observations: ProviderObservation[];
  /** Mapped paths the payload did not contain. Nothing is filled in for them. */
  absent: string[];
}

export function extractObservations(
  targetType: ProviderTargetType,
  payload: unknown,
  mappings: readonly FieldMapping[] = mappingsFor(targetType)
): ExtractedObservations {
  const promotable: Record<string, unknown> = {};
  const observations: ProviderObservation[] = [];
  const absent: string[] = [];
  for (const mapping of mappings) {
    const value = readMapping(payload, mapping);
    if (isBlank(value)) {
      absent.push(mapping.attribute);
      continue;
    }
    const contactData = mapping.contactData === true;
    const canPromote = mapping.status === "verified" && !contactData;
    observations.push({
      attribute: mapping.attribute,
      path: mapping.path,
      mappingStatus: mapping.status,
      contactData,
      promotable: canPromote,
    });
    if (canPromote) promotable[mapping.attribute] = value;
  }
  return { mappingVersion: UNIPILE_MAPPING_VERSION, promotable, observations, absent };
}
