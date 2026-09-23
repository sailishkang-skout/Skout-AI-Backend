/**
 * AUTH-BE-11 — password hashing and credential service.
 *
 * Pure crypto/policy logic, no DB access: callers (BE-14's login/signup endpoints, BE-21's
 * import tool) are responsible for reading/writing `user_credentials` rows. Keeping this
 * storage-agnostic is what makes it independently unit-testable and reusable from the import
 * CLI without pulling in a request context.
 */
import * as argon2 from "@node-rs/argon2";
import * as bcrypt from "@node-rs/bcrypt";
import { COMMON_BREACHED_PASSWORDS } from "../data/breached-passwords.js";

export const MIN_PASSWORD_LENGTH = 10;
export const MAX_PASSWORD_LENGTH = 128;

export type HashAlgo = "argon2id" | "bcrypt";

/**
 * Current argon2id parameters. These match @node-rs/argon2's own defaults (OWASP's current
 * baseline recommendation: 19 MiB memory, 2 iterations, 1 thread) but are declared explicitly
 * — not left as "whatever the library defaults to today" — so a future deliberate change here
 * is what `needsRehash` compares against, and upgrading the library can never silently change
 * what "current" means.
 */
export const CURRENT_ARGON2_PARAMS = {
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
} as const;

export interface HashResult {
  hash: string;
  algo: "argon2id";
  params: typeof CURRENT_ARGON2_PARAMS;
}

export interface StoredCredential {
  passwordHash: string;
  hashAlgo: string;
  hashParams: unknown;
}

export interface VerifyResult {
  valid: boolean;
  /** True when a successful login should trigger a rehash-and-store with hashPassword(). */
  needsRehash: boolean;
}

/** Hash a new password with the current argon2id parameters. */
export async function hashPassword(password: string): Promise<HashResult> {
  const hash = await argon2.hash(password, {
    algorithm: argon2.Algorithm.Argon2id,
    ...CURRENT_ARGON2_PARAMS,
  });
  return { hash, algo: "argon2id", params: CURRENT_ARGON2_PARAMS };
}

function paramsMatchCurrent(params: unknown): boolean {
  if (!params || typeof params !== "object") return false;
  const p = params as Record<string, unknown>;
  return (
    p.memoryCost === CURRENT_ARGON2_PARAMS.memoryCost &&
    p.timeCost === CURRENT_ARGON2_PARAMS.timeCost &&
    p.parallelism === CURRENT_ARGON2_PARAMS.parallelism
  );
}

/**
 * Verify a password against a stored credential, and report whether it should be rehashed:
 * - argon2id with stale params (a past parameter bump) → rehash to current params.
 * - bcrypt (imported from Clerk, AUTH-BE-21) → always rehash to argon2id on first successful
 *   login, per D5 and this ticket's acceptance criteria ("bcrypt import verify-then-upgrade").
 */
export async function verifyPassword(
  password: string,
  credential: StoredCredential
): Promise<VerifyResult> {
  if (credential.hashAlgo === "argon2id") {
    const valid = await argon2.verify(credential.passwordHash, password);
    return { valid, needsRehash: valid && !paramsMatchCurrent(credential.hashParams) };
  }
  if (credential.hashAlgo === "bcrypt") {
    const valid = await bcrypt.compare(password, credential.passwordHash);
    return { valid, needsRehash: valid };
  }
  // Unknown algo: never treat as a valid credential, but still take real crypto time so this
  // path can't be distinguished from a genuine mismatch by response timing.
  await argon2.verify(await getDummyHash(), password).catch(() => undefined);
  return { valid: false, needsRehash: false };
}

let dummyHashPromise: Promise<string> | null = null;

/**
 * A fixed argon2id hash of a password nobody will ever type, computed once and cached. Used to
 * run a real hash comparison for unknown-user login attempts, so the response time for
 * "no such account" is indistinguishable from "wrong password" (Ground Rule 6 / BE-14's
 * anti-enumeration requirement).
 */
async function getDummyHash(): Promise<string> {
  if (!dummyHashPromise) {
    dummyHashPromise = argon2.hash("dummy-password-for-timing-only-never-a-real-credential", {
      algorithm: argon2.Algorithm.Argon2id,
      ...CURRENT_ARGON2_PARAMS,
    });
  }
  return dummyHashPromise;
}

/**
 * Run the same-cost dummy comparison used internally for unknown algos, for callers (BE-14)
 * that need to burn real verification time for a login attempt against an email with no
 * `user_credentials` row at all.
 */
export async function verifyUnknownUser(password: string): Promise<VerifyResult> {
  await argon2.verify(await getDummyHash(), password).catch(() => false);
  return { valid: false, needsRehash: false };
}

export interface PasswordPolicyResult {
  ok: boolean;
  reasons: string[];
}

/**
 * Minimum length ≥10, max 128, no composition rules (OWASP guidance — composition rules push
 * users toward predictable patterns), reject common/breached passwords.
 */
export function checkPasswordPolicy(password: string): PasswordPolicyResult {
  const reasons: string[] = [];
  if (password.length < MIN_PASSWORD_LENGTH) {
    reasons.push(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
  }
  if (password.length > MAX_PASSWORD_LENGTH) {
    reasons.push(`Password must be at most ${MAX_PASSWORD_LENGTH} characters.`);
  }
  if (COMMON_BREACHED_PASSWORDS.has(password.toLowerCase())) {
    reasons.push("This password is too common. Choose something less predictable.");
  }
  return { ok: reasons.length === 0, reasons };
}
