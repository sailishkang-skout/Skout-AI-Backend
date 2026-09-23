import { describe, expect, it } from "vitest";
import {
  applyAuthModeEnv,
  assertAuthModeBootGuards,
  authRuntimeFlags,
  deriveLegacyAuthMode,
  resolveAuthMode,
} from "./auth-mode.js";

const validClerk = "sk_live_clerk_secret";
const validOwnAuth = {
  authJwtPrivateKey: '{"kty":"OKP","crv":"Ed25519","d":"x","x":"y"}',
  authJwtKid: "kid-1",
  authJwtPublicKeySet: '{"keys":[{"kty":"OKP","crv":"Ed25519","x":"y"}]}',
};

describe("deriveLegacyAuthMode (AUTH-BE-06)", () => {
  it("derives stub when AUTH_STUB is true", () => {
    expect(deriveLegacyAuthMode(true, validClerk)).toBe("stub");
  });

  it("derives stub when Clerk key is missing or placeholder", () => {
    expect(deriveLegacyAuthMode(false, undefined)).toBe("stub");
    expect(deriveLegacyAuthMode(false, "replace-me")).toBe("stub");
  });

  it("derives clerk when stub is false and Clerk key is valid", () => {
    expect(deriveLegacyAuthMode(false, validClerk)).toBe("clerk");
  });
});

describe("resolveAuthMode — legacy (no AUTH_MODE)", () => {
  it("marks legacy derivation and matches today's stub/clerk split", () => {
    const stub = resolveAuthMode({
      nodeEnv: "test",
      authStub: true,
      clerkSecretKey: validClerk,
      appRole: "api",
    });
    expect(stub).toMatchObject({
      AUTH_MODE: "stub",
      AUTH_MODE_LEGACY_DERIVED: true,
      AUTH_USE_STUB: true,
      AUTH_USE_CLERK_JWT: false,
    });

    const clerk = resolveAuthMode({
      nodeEnv: "test",
      authStub: false,
      clerkSecretKey: validClerk,
      appRole: "api",
    });
    expect(clerk).toMatchObject({
      AUTH_MODE: "clerk",
      AUTH_MODE_LEGACY_DERIVED: true,
      AUTH_USE_STUB: false,
      AUTH_USE_CLERK_JWT: true,
    });
  });

  it("supports e2e-style AUTH_STUB=true with empty Clerk key", () => {
    const resolved = resolveAuthMode({
      nodeEnv: "test",
      authStub: true,
      clerkSecretKey: "",
      appRole: "api",
    });
    expect(resolved.AUTH_MODE).toBe("stub");
    expect(() => assertAuthModeBootGuards(resolved, {
      nodeEnv: "test",
      authStub: true,
      clerkSecretKey: "",
      appRole: "api",
    })).not.toThrow();
  });
});

describe("assertAuthModeBootGuards", () => {
  it("refuses production when legacy-derived stub", () => {
    const resolved = resolveAuthMode({
      nodeEnv: "production",
      authStub: false,
      clerkSecretKey: undefined,
      appRole: "api",
    });
    expect(() =>
      assertAuthModeBootGuards(resolved, {
        nodeEnv: "production",
        authStub: false,
        clerkSecretKey: undefined,
        appRole: "api",
      })
    ).toThrow("Production requires CLERK_SECRET_KEY and AUTH_STUB must be false");
  });

  it("refuses production + explicit AUTH_MODE=stub", () => {
    const resolved = resolveAuthMode({
      authModeRaw: "stub",
      nodeEnv: "production",
      authStub: true,
      clerkSecretKey: validClerk,
      appRole: "api",
    });
    expect(() =>
      assertAuthModeBootGuards(resolved, {
        authModeRaw: "stub",
        nodeEnv: "production",
        authStub: true,
        clerkSecretKey: validClerk,
        appRole: "api",
      })
    ).toThrow("Production requires CLERK_SECRET_KEY and AUTH_STUB must be false");
  });

  it("refuses production + AUTH_MODE=clerk with missing Clerk key", () => {
    const resolved = resolveAuthMode({
      authModeRaw: "clerk",
      nodeEnv: "production",
      authStub: false,
      clerkSecretKey: undefined,
      appRole: "api",
    });
    expect(() =>
      assertAuthModeBootGuards(resolved, {
        authModeRaw: "clerk",
        nodeEnv: "production",
        authStub: false,
        clerkSecretKey: undefined,
        appRole: "api",
      })
    ).toThrow("Production requires CLERK_SECRET_KEY and AUTH_STUB must be false");
  });

  it("refuses explicit AUTH_MODE=stub without AUTH_STUB opt-in", () => {
    const resolved = resolveAuthMode({
      authModeRaw: "stub",
      nodeEnv: "test",
      authStub: false,
      clerkSecretKey: validClerk,
      appRole: "api",
    });
    expect(() =>
      assertAuthModeBootGuards(resolved, {
        authModeRaw: "stub",
        nodeEnv: "test",
        authStub: false,
        clerkSecretKey: validClerk,
        appRole: "api",
      })
    ).toThrow("AUTH_MODE=stub requires AUTH_STUB=true");
  });

  it("refuses explicit AUTH_MODE=clerk without a Clerk key in non-production", () => {
    const resolved = resolveAuthMode({
      authModeRaw: "clerk",
      nodeEnv: "development",
      authStub: false,
      clerkSecretKey: undefined,
      appRole: "api",
    });
    expect(() =>
      assertAuthModeBootGuards(resolved, {
        authModeRaw: "clerk",
        nodeEnv: "development",
        authStub: false,
        clerkSecretKey: undefined,
        appRole: "api",
      })
    ).toThrow("AUTH_MODE=clerk requires a valid CLERK_SECRET_KEY");
  });

  it("requires own-auth key material for custom/dual on api", () => {
    const dual = resolveAuthMode({
      authModeRaw: "dual",
      nodeEnv: "test",
      authStub: false,
      clerkSecretKey: validClerk,
      appRole: "api",
    });
    expect(() =>
      assertAuthModeBootGuards(dual, {
        authModeRaw: "dual",
        nodeEnv: "test",
        authStub: false,
        clerkSecretKey: validClerk,
        appRole: "api",
      })
    ).toThrow("AUTH_JWT_PUBLIC_KEY_SET");

    expect(() =>
      applyAuthModeEnv({
        authModeRaw: "dual",
        nodeEnv: "test",
        authStub: false,
        clerkSecretKey: validClerk,
        appRole: "api",
        ...validOwnAuth,
      })
    ).not.toThrow();
  });
});

describe("authRuntimeFlags", () => {
  it("re-derives stub when legacy config overrides Clerk key at runtime", () => {
    const flags = authRuntimeFlags({
      nodeEnv: "test",
      authStub: false,
      clerkSecretKey: undefined,
      AUTH_MODE_LEGACY_DERIVED: true,
      AUTH_MODE: "clerk",
      AUTH_USE_STUB: false,
      appRole: "api",
    });
    expect(flags.AUTH_USE_STUB).toBe(true);
  });
});
