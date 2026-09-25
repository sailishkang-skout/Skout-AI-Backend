import { describe, expect, it, beforeAll } from "vitest";
import { generateKeyPair, exportJWK, exportPKCS8, SignJWT } from "jose";
import { skoutAuthProvider } from "./skout-provider.js";
import { AuthTokenExpiredError, AuthTokenInvalidError } from "./auth-token.js";

describe("SkoutAuthProvider (AUTH-BE-19)", () => {
  let privateKeyPem: string;
  let jwksJson: string;
  const issuer = "https://auth.skout.test";
  const audience = "skout-api-test";
  const kid = "test-skout-kid";

  beforeAll(async () => {
    const { publicKey, privateKey } = await generateKeyPair("RS256", { modulusLength: 2048, extractable: true });
    const jwk = await exportJWK(publicKey);
    jwk.kid = kid;
    jwk.alg = "RS256";
    jwk.use = "sig";
    jwksJson = JSON.stringify({ keys: [jwk] });
    privateKeyPem = await exportPKCS8(privateKey);
  });

  async function makeToken(opts: {
    sub?: string;
    sid?: string;
    exp?: string | number;
    iss?: string;
    aud?: string;
    kidHeader?: string;
  } = {}) {
    const { importPKCS8 } = await import("jose");
    const key = await importPKCS8(privateKeyPem, "RS256");
    const builder = new SignJWT({ sid: opts.sid ?? "session-123" })
      .setProtectedHeader({ alg: "RS256", kid: opts.kidHeader ?? kid })
      .setIssuer(opts.iss ?? issuer)
      .setAudience(opts.aud ?? audience)
      .setSubject(opts.sub ?? "user-uuid-123")
      .setIssuedAt();
    
    if (typeof opts.exp === "number") {
      builder.setExpirationTime(opts.exp);
    } else {
      builder.setExpirationTime(opts.exp ?? "10m");
    }

    return builder.sign(key);
  }

  it("verifies valid Skout JWT and returns VerifiedIdentity with sub and sessionId", async () => {
    const token = await makeToken({ sub: "user-456", sid: "session-789" });
    const identity = await skoutAuthProvider.verify(token, {
      skoutJwtIssuer: issuer,
      skoutJwtAudience: audience,
      skoutJwtPublicKeySet: jwksJson,
    });

    expect(identity).toEqual({
      provider: "skout",
      subject: "user-456",
      sessionId: "session-789",
      emailVerified: true,
    });
  });

  it("rejects expired token with AuthTokenExpiredError", async () => {
    const token = await makeToken({ exp: Math.floor(Date.now() / 1000) - 60 });
    await expect(
      skoutAuthProvider.verify(token, {
        skoutJwtIssuer: issuer,
        skoutJwtAudience: audience,
        skoutJwtPublicKeySet: jwksJson,
      })
    ).rejects.toThrow(AuthTokenExpiredError);
  });

  it("rejects token with wrong issuer", async () => {
    const token = await makeToken({ iss: "https://wrong.issuer" });
    await expect(
      skoutAuthProvider.verify(token, {
        skoutJwtIssuer: issuer,
        skoutJwtAudience: audience,
        skoutJwtPublicKeySet: jwksJson,
      })
    ).rejects.toThrow(AuthTokenInvalidError);
  });

  it("rejects token with wrong audience", async () => {
    const token = await makeToken({ aud: "wrong-audience" });
    await expect(
      skoutAuthProvider.verify(token, {
        skoutJwtIssuer: issuer,
        skoutJwtAudience: audience,
        skoutJwtPublicKeySet: jwksJson,
      })
    ).rejects.toThrow(AuthTokenInvalidError);
  });

  it("rejects token with unknown kid", async () => {
    const token = await makeToken({ kidHeader: "unknown-kid" });
    await expect(
      skoutAuthProvider.verify(token, {
        skoutJwtIssuer: issuer,
        skoutJwtAudience: audience,
        skoutJwtPublicKeySet: jwksJson,
      })
    ).rejects.toThrow(AuthTokenInvalidError);
  });

  it("fails when Skout config is incomplete", async () => {
    const token = await makeToken();
    await expect(
      skoutAuthProvider.verify(token, {
        skoutJwtIssuer: issuer,
        // missing audience and public key set
      })
    ).rejects.toThrow(AuthTokenInvalidError);
  });
});

