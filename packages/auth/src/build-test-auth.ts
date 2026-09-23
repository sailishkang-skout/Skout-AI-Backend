import type { VerifiedIdentity } from "./auth-provider.js";
import type { ResolveAuthConfig } from "./resolve-auth.js";
import {
  clearFixtureTokenIdentities,
  createFixtureAuthProvider,
  registerFixtureTokenIdentity,
} from "./fixture-auth-provider.js";
import {
  getTestAuthProvider,
  registerTestAuthProvider,
  resetTestAuthProviders,
} from "./test-auth-registry.js";

/** Default Clerk-shaped issuer for backend Vitest (not a real Clerk deployment). */
export const TEST_CLERK_ISSUER = "https://clerk.test.skout";

/** Skout own-auth issuer for dual-mode / BE-19 tests. */
export const TEST_SKOUT_AUTH_ISSUER = "https://auth.skout.test";

const DEFAULT_WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";

export type TestAuthProviderKind = "clerk" | "skout";

export type BuildTestAuthOptions = {
  /** Maps to JWT `sub` / VerifiedIdentity.subject when not using `subject`. */
  userId?: string;
  subject?: string;
  email?: string;
  name?: string;
  emailVerified?: boolean;
  provider?: TestAuthProviderKind;
  issuer?: string;
  workspaceId?: string;
  role?: string;
};

export type BuildTestAuthResult = {
  token: string;
  bearer: string;
  identity: VerifiedIdentity;
  userId: string;
  email: string;
  workspaceId: string;
  role: string;
  issuer: string;
  resolveAuthConfig: ResolveAuthConfig;
};

let harnessReady = false;

function providerIdForKind(kind: TestAuthProviderKind): string {
  return kind === "skout" ? "skout" : "clerk";
}

function issuerForOptions(options: BuildTestAuthOptions): string {
  if (options.issuer) return options.issuer;
  return options.provider === "skout" ? TEST_SKOUT_AUTH_ISSUER : TEST_CLERK_ISSUER;
}

/** Unsigned JWT-shaped token so `resolveAuth` can peek `iss` before the test provider verifies. */
export function buildTestAuthToken(
  issuerOrOptions: string | BuildTestAuthOptions = TEST_CLERK_ISSUER,
  subject = "jwt-peek-subject"
): string {
  if (typeof issuerOrOptions === "object") {
    const opts = issuerOrOptions;
    const issuer = issuerForOptions(opts);
    const sub = opts.subject ?? opts.userId ?? "jwt-peek-subject";
    return buildUnsignedJwt(issuer, sub, {
      email: opts.email,
      name: opts.name,
      email_verified: opts.emailVerified,
    });
  }
  return buildUnsignedJwt(issuerOrOptions, subject);
}

function buildUnsignedJwt(
  issuer: string,
  subject: string,
  extraPayload: Record<string, unknown> = {}
): string {
  const header = Buffer.from(JSON.stringify({ alg: "RS256", kid: "k1" })).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({ iss: issuer, sub: subject, ...extraPayload })
  ).toString("base64url");
  return `${header}.${payload}.mock-signature`;
}

/**
 * Registers fixture providers for standard test issuers (idempotent per Vitest worker).
 * Call from app `setup.ts` beforeEach hooks.
 */
export function ensureTestAuthHarness(): void {
  if (harnessReady) return;
  registerTestAuthProvider(TEST_CLERK_ISSUER, createFixtureAuthProvider("clerk"));
  registerTestAuthProvider(TEST_SKOUT_AUTH_ISSUER, createFixtureAuthProvider("skout"));
  harnessReady = true;
}

/** Clears harness state between tests (providers + per-token identity overrides). */
export function resetTestAuthHarness(): void {
  resetTestAuthProviders();
  clearFixtureTokenIdentities();
  harnessReady = false;
}

/**
 * AUTH-BE-09 — provider-neutral auth fixture for API/CRM tests.
 * Registers a verified identity for the returned token on the shared test AuthProvider.
 */
export function buildTestAuth(options: BuildTestAuthOptions = {}): BuildTestAuthResult {
  ensureTestAuthHarness();

  const providerKind = options.provider ?? "clerk";
  const issuer = issuerForOptions(options);
  const subject = options.subject ?? options.userId ?? "test-user-subject";
  const email = options.email ?? "test@example.com";
  const name = options.name ?? "Test User";
  const emailVerified = options.emailVerified ?? true;
  const workspaceId = options.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const role = options.role ?? "member";
  const userId = options.userId ?? subject;

  const token = buildUnsignedJwt(issuer, subject, {
    email,
    name,
    email_verified: emailVerified,
  });

  const identity: VerifiedIdentity = {
    provider: providerIdForKind(providerKind),
    subject,
    email,
    emailVerified,
    name,
  };

  if (!getTestAuthProvider(issuer)) {
    registerTestAuthProvider(issuer, createFixtureAuthProvider(identity.provider));
  }
  registerFixtureTokenIdentity(token, identity);

  const resolveAuthConfig: ResolveAuthConfig = {
    clerkJwtIssuer: issuer,
    clerkSecretKey: "sk_test_clerk",
    authorizedParties: ["http://localhost:3000"],
  };

  return {
    token,
    bearer: `Bearer ${token}`,
    identity,
    userId,
    email,
    workspaceId,
    role,
    issuer,
    resolveAuthConfig,
  };
}

/** Env overrides for Fastify apps exercising real `resolveAuth` in Vitest. */
export function buildTestAuthEnv(
  issuer = TEST_CLERK_ISSUER,
  extra: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    CLERK_SECRET_KEY: "sk_test_clerk",
    CLERK_JWT_ISSUER: issuer,
    AUTH_STUB: false,
    AUTH_MODE: "clerk",
    ...extra,
  };
}

/** @deprecated Use `buildTestAuthToken` — kept for mechanical migration from clerk-test-jwt. */
export const buildFakeClerkJwt = buildTestAuthToken;
