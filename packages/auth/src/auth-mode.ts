export const AUTH_MODE_VALUES = ["clerk", "stub", "custom", "dual"] as const;
export type AuthMode = (typeof AUTH_MODE_VALUES)[number];

export const AUTH_MODE_DEPRECATION_WARNING =
  "AUTH_MODE is unset — deriving auth mode from AUTH_STUB and CLERK_SECRET_KEY. Set AUTH_MODE explicitly (AUTH-ADI-08).";

const PRODUCTION_STUB_ERROR = "Production requires CLERK_SECRET_KEY and AUTH_STUB must be false";

function isPlaceholder(value?: string): boolean {
  return !value || value.trim() === "" || value.trim().toLowerCase() === "replace-me";
}

export function isClerkSecretKeyInvalid(clerkSecretKey?: string): boolean {
  return isPlaceholder(clerkSecretKey);
}

export const ACCEPTED_ISSUER_VALUES = ["clerk", "skout"] as const;
export type AcceptedIssuer = (typeof ACCEPTED_ISSUER_VALUES)[number];

export function parseAcceptedIssuers(raw?: string, fallbackMode?: AuthMode): AcceptedIssuer[] {
  if (raw && raw.trim()) {
    const list = raw
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
    const valid = list.filter((s): s is AcceptedIssuer =>
      (ACCEPTED_ISSUER_VALUES as readonly string[]).includes(s)
    );
    if (valid.length > 0) return Array.from(new Set(valid));
  }

  if (fallbackMode === "dual") return ["clerk", "skout"];
  if (fallbackMode === "custom") return ["skout"];
  return ["clerk"];
}

export function parseAuthModeEnv(raw?: string): AuthMode | undefined {
  if (!raw || !raw.trim()) return undefined;
  const normalized = raw.trim().toLowerCase();
  if ((AUTH_MODE_VALUES as readonly string[]).includes(normalized)) {
    return normalized as AuthMode;
  }
  throw new Error(`Invalid AUTH_MODE "${raw}" — expected clerk | stub | custom | dual`);
}

/** Legacy behavior when AUTH_MODE is omitted (AUTH-BE-06). */
export function deriveLegacyAuthMode(authStub: boolean, clerkSecretKey?: string): AuthMode {
  if (authStub || isClerkSecretKeyInvalid(clerkSecretKey)) return "stub";
  return "clerk";
}

export type AuthModeAppRole = "api" | "crm";

export type AuthModeEnvInput = {
  authModeRaw?: string;
  nodeEnv: "development" | "production" | "test";
  authStub: boolean;
  clerkSecretKey?: string;
  authJwtPrivateKey?: string;
  authJwtKid?: string;
  authJwtPublicKeySet?: string;
  appRole: AuthModeAppRole;
};

export type ResolvedAuthMode = {
  AUTH_MODE: AuthMode;
  /** True when AUTH_MODE was omitted and legacy derivation ran. */
  AUTH_MODE_LEGACY_DERIVED: boolean;
  AUTH_USE_STUB: boolean;
  /** Clerk session JWT verification (clerk or dual during migration). */
  AUTH_USE_CLERK_JWT: boolean;
};

export function resolveAuthMode(input: AuthModeEnvInput): ResolvedAuthMode {
  const explicit = input.authModeRaw ? parseAuthModeEnv(input.authModeRaw) : undefined;
  const authMode = explicit ?? deriveLegacyAuthMode(input.authStub, input.clerkSecretKey);
  const AUTH_MODE_LEGACY_DERIVED = explicit === undefined;

  return {
    AUTH_MODE: authMode,
    AUTH_MODE_LEGACY_DERIVED,
    AUTH_USE_STUB: authMode === "stub",
    AUTH_USE_CLERK_JWT: authMode === "clerk" || authMode === "dual",
  };
}

function assertOwnAuthKeyMaterial(input: AuthModeEnvInput, authMode: AuthMode): void {
  if (authMode !== "custom" && authMode !== "dual") return;

  if (isPlaceholder(input.authJwtPublicKeySet)) {
    throw new Error("AUTH_MODE requires AUTH_JWT_PUBLIC_KEY_SET to be configured");
  }
  if (input.appRole === "api") {
    if (isPlaceholder(input.authJwtPrivateKey) || isPlaceholder(input.authJwtKid)) {
      throw new Error("AUTH_MODE requires AUTH_JWT_PRIVATE_KEY and AUTH_JWT_KID to be configured");
    }
  }
}

/**
 * Fail closed at process boot — mirrors legacy guards when AUTH_MODE is unset,
 * and enforces explicit AUTH_MODE rules when set.
 */
export function assertAuthModeBootGuards(resolved: ResolvedAuthMode, input: AuthModeEnvInput): void {
  const { AUTH_MODE, AUTH_MODE_LEGACY_DERIVED } = resolved;
  const production = input.nodeEnv === "production";

  if (production && AUTH_MODE === "stub") {
    throw new Error(PRODUCTION_STUB_ERROR);
  }

  if (AUTH_MODE === "stub" && !AUTH_MODE_LEGACY_DERIVED && !input.authStub) {
    throw new Error("AUTH_MODE=stub requires AUTH_STUB=true");
  }

  if (AUTH_MODE_LEGACY_DERIVED && production) {
    if (input.authStub || isClerkSecretKeyInvalid(input.clerkSecretKey)) {
      throw new Error(PRODUCTION_STUB_ERROR);
    }
  }

  if (production && AUTH_MODE === "clerk" && isClerkSecretKeyInvalid(input.clerkSecretKey)) {
    throw new Error(PRODUCTION_STUB_ERROR);
  }

  if (production && AUTH_MODE === "dual" && isClerkSecretKeyInvalid(input.clerkSecretKey)) {
    throw new Error("Production requires a valid CLERK_SECRET_KEY when AUTH_MODE=dual");
  }

  assertOwnAuthKeyMaterial(input, AUTH_MODE);

  if (!AUTH_MODE_LEGACY_DERIVED && AUTH_MODE === "clerk" && isClerkSecretKeyInvalid(input.clerkSecretKey)) {
    throw new Error("AUTH_MODE=clerk requires a valid CLERK_SECRET_KEY");
  }
}

export function applyAuthModeEnv(input: AuthModeEnvInput): ResolvedAuthMode {
  const resolved = resolveAuthMode(input);
  assertAuthModeBootGuards(resolved, input);
  return resolved;
}

type AuthRuntimeConfigInput = Partial<AuthModeEnvInput> &
  Partial<ResolvedAuthMode> & {
    AUTH_MODE?: AuthMode;
    AUTH_STUB?: boolean;
    CLERK_SECRET_KEY?: string;
    NODE_ENV?: AuthModeEnvInput["nodeEnv"];
    appRole: AuthModeAppRole;
  };

/**
 * Runtime flags for auth plugins. Re-derives from legacy inputs when tests override
 * CLERK_SECRET_KEY / AUTH_STUB without re-running loadEnv().
 */
export function authRuntimeFlags(input: AuthRuntimeConfigInput): ResolvedAuthMode {
  const explicit =
    input.AUTH_MODE_LEGACY_DERIVED === false &&
    input.AUTH_MODE !== undefined &&
    input.AUTH_USE_STUB !== undefined;

  if (explicit && input.AUTH_MODE && input.AUTH_USE_STUB !== undefined) {
    return {
      AUTH_MODE: input.AUTH_MODE,
      AUTH_MODE_LEGACY_DERIVED: false,
      AUTH_USE_STUB: input.AUTH_USE_STUB,
      AUTH_USE_CLERK_JWT:
        input.AUTH_USE_CLERK_JWT ??
        (input.AUTH_MODE === "clerk" || input.AUTH_MODE === "dual"),
    };
  }

  const legacyDerived = input.AUTH_MODE_LEGACY_DERIVED !== false;
  return resolveAuthMode({
    authModeRaw: legacyDerived ? undefined : input.authModeRaw ?? input.AUTH_MODE,
    nodeEnv: input.nodeEnv ?? input.NODE_ENV ?? "development",
    authStub: input.authStub ?? input.AUTH_STUB ?? false,
    clerkSecretKey: input.clerkSecretKey ?? input.CLERK_SECRET_KEY,
    authJwtPrivateKey: input.authJwtPrivateKey,
    authJwtKid: input.authJwtKid,
    authJwtPublicKeySet: input.authJwtPublicKeySet,
    appRole: input.appRole,
  });
}
