import { generateKeyPair, exportJWK, exportPKCS8 } from "jose";
import { beforeAll, describe, expect, it } from "vitest";
import { HttpError } from "../utils/http.js";
import {
  ACCESS_TOKEN_TTL_SECONDS,
  getPublicJwks,
  signAccessToken,
  verifyAccessToken,
} from "./token.service.js";
import type { Env } from "../config/env.js";

async function makeKeyPair(kid: string) {
  const { publicKey, privateKey } = await generateKeyPair("RS256", { modulusLength: 2048, extractable: true });
  const jwk = await exportJWK(publicKey);
  jwk.kid = kid;
  jwk.alg = "RS256";
  jwk.use = "sig";
  const pem = await exportPKCS8(privateKey);
  return { pem, jwk };
}

function baseConfig(overrides: Partial<Env> = {}): Env {
  return {
    AUTH_JWT_ISSUER: "https://auth.test.local",
    AUTH_JWT_AUDIENCE: "skout-api-test",
    ...overrides,
  } as Env;
}

describe("token.service", () => {
  let keyA: { pem: string; jwk: ReturnType<typeof JSON.parse> };
  let keyB: { pem: string; jwk: ReturnType<typeof JSON.parse> };
  let configA: Env;
  let configBoth: Env;

  beforeAll(async () => {
    keyA = await makeKeyPair("kid-a");
    keyB = await makeKeyPair("kid-b");
    configA = baseConfig({
      AUTH_JWT_PRIVATE_KEY: keyA.pem,
      AUTH_JWT_KID: "kid-a",
      AUTH_JWT_PUBLIC_KEY_SET: JSON.stringify({ keys: [keyA.jwk] }),
    });
    configBoth = baseConfig({
      AUTH_JWT_PRIVATE_KEY: keyB.pem,
      AUTH_JWT_KID: "kid-b",
      AUTH_JWT_PUBLIC_KEY_SET: JSON.stringify({ keys: [keyA.jwk, keyB.jwk] }),
    });
  });

  it("signs and verifies a token round-trip", async () => {
    const token = await signAccessToken({ sub: "user-1", sid: "session-1" }, configA);
    const verified = await verifyAccessToken(token, configA);
    expect(verified.sub).toBe("user-1");
    expect(verified.sid).toBe("session-1");
    expect(verified.exp - verified.iat).toBe(ACCESS_TOKEN_TTL_SECONDS);
  });

  it("never puts email/role/workspace claims on the token (§3)", async () => {
    const token = await signAccessToken({ sub: "user-1", sid: "session-1" }, configA);
    const [, payloadB64] = token.split(".");
    const payload = JSON.parse(Buffer.from(payloadB64!, "base64url").toString());
    expect(payload).not.toHaveProperty("email");
    expect(payload).not.toHaveProperty("role");
    expect(payload).not.toHaveProperty("workspaceId");
    expect(Object.keys(payload).sort()).toEqual(["aud", "exp", "iat", "iss", "sid", "sub"]);
  });

  describe("forgery rejection", () => {
    it("rejects a token signed with an unpublished key", async () => {
      const rogue = await makeKeyPair("kid-rogue");
      const rogueConfig = baseConfig({
        AUTH_JWT_PRIVATE_KEY: rogue.pem,
        AUTH_JWT_KID: "kid-rogue",
        AUTH_JWT_PUBLIC_KEY_SET: JSON.stringify({ keys: [rogue.jwk] }),
      });
      const token = await signAccessToken({ sub: "user-1", sid: "session-1" }, rogueConfig);
      // Verify against configA's JWKS, which does not contain kid-rogue.
      await expect(verifyAccessToken(token, configA)).rejects.toThrow(HttpError);
    });

    it("rejects alg:none", async () => {
      const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
      const payload = Buffer.from(
        JSON.stringify({
          sub: "user-1",
          sid: "session-1",
          iss: "https://auth.test.local",
          aud: "skout-api-test",
          iat: Math.floor(Date.now() / 1000),
          exp: Math.floor(Date.now() / 1000) + 600,
        })
      ).toString("base64url");
      const forged = `${header}.${payload}.`;
      await expect(verifyAccessToken(forged, configA)).rejects.toThrow(HttpError);
    });

    it("rejects a wrong-kid header even if the signature happens to verify against a different key", async () => {
      const token = await signAccessToken({ sub: "user-1", sid: "session-1" }, configA);
      const [headerB64, payloadB64, sigB64] = token.split(".");
      const header = JSON.parse(Buffer.from(headerB64!, "base64url").toString());
      header.kid = "kid-does-not-exist";
      const tampered = `${Buffer.from(JSON.stringify(header)).toString("base64url")}.${payloadB64}.${sigB64}`;
      await expect(verifyAccessToken(tampered, configA)).rejects.toThrow(HttpError);
    });

    it("rejects wrong audience", async () => {
      const token = await signAccessToken({ sub: "user-1", sid: "session-1" }, configA);
      const wrongAud = baseConfig({
        AUTH_JWT_PRIVATE_KEY: keyA.pem,
        AUTH_JWT_KID: "kid-a",
        AUTH_JWT_PUBLIC_KEY_SET: JSON.stringify({ keys: [keyA.jwk] }),
        AUTH_JWT_AUDIENCE: "some-other-api",
      });
      await expect(verifyAccessToken(token, wrongAud)).rejects.toThrow(HttpError);
    });

    it("rejects wrong issuer", async () => {
      const token = await signAccessToken({ sub: "user-1", sid: "session-1" }, configA);
      const wrongIss = baseConfig({
        AUTH_JWT_PRIVATE_KEY: keyA.pem,
        AUTH_JWT_KID: "kid-a",
        AUTH_JWT_PUBLIC_KEY_SET: JSON.stringify({ keys: [keyA.jwk] }),
        AUTH_JWT_ISSUER: "https://not-us.example",
      });
      await expect(verifyAccessToken(token, wrongIss)).rejects.toThrow(HttpError);
    });

    it("rejects an expired token", async () => {
      const { SignJWT, importPKCS8 } = await import("jose");
      const privateKey = await importPKCS8(keyA.pem, "RS256");
      const expired = await new SignJWT({ sid: "session-1" })
        .setProtectedHeader({ alg: "RS256", kid: "kid-a" })
        .setIssuer("https://auth.test.local")
        .setAudience("skout-api-test")
        .setSubject("user-1")
        .setIssuedAt(Math.floor(Date.now() / 1000) - 3600)
        .setExpirationTime(Math.floor(Date.now() / 1000) - 60)
        .sign(privateKey);
      await expect(verifyAccessToken(expired, configA)).rejects.toMatchObject({ message: "AUTH_TOKEN_EXPIRED" });
    });

    it("rejects a token that is not yet valid (nbf in the future)", async () => {
      const { SignJWT, importPKCS8 } = await import("jose");
      const privateKey = await importPKCS8(keyA.pem, "RS256");
      const future = Math.floor(Date.now() / 1000) + 3600;
      const notYetValid = await new SignJWT({ sid: "session-1" })
        .setProtectedHeader({ alg: "RS256", kid: "kid-a" })
        .setIssuer("https://auth.test.local")
        .setAudience("skout-api-test")
        .setSubject("user-1")
        .setIssuedAt()
        .setNotBefore(future)
        .setExpirationTime(future + 600)
        .sign(privateKey);
      await expect(verifyAccessToken(notYetValid, configA)).rejects.toThrow(HttpError);
    });

    it("rejects a tampered payload (signature no longer matches)", async () => {
      const token = await signAccessToken({ sub: "user-1", sid: "session-1" }, configA);
      const [headerB64, payloadB64, sigB64] = token.split(".");
      const payload = JSON.parse(Buffer.from(payloadB64!, "base64url").toString());
      payload.sub = "user-2"; // attacker tries to impersonate a different user
      const tamperedPayload = Buffer.from(JSON.stringify(payload)).toString("base64url");
      const tampered = `${headerB64}.${tamperedPayload}.${sigB64}`;
      await expect(verifyAccessToken(tampered, configA)).rejects.toThrow(HttpError);
    });
  });

  describe("key rotation", () => {
    it("a token signed with the old key still verifies while both keys are published", async () => {
      const oldToken = await signAccessToken({ sub: "user-1", sid: "session-1" }, configA);
      // configBoth signs with kid-b but publishes both kid-a and kid-b.
      const verified = await verifyAccessToken(oldToken, configBoth);
      expect(verified.sub).toBe("user-1");
    });

    it("fails once the old key is removed from the published set", async () => {
      const oldToken = await signAccessToken({ sub: "user-1", sid: "session-1" }, configA);
      const onlyNewKey = baseConfig({
        AUTH_JWT_PRIVATE_KEY: keyB.pem,
        AUTH_JWT_KID: "kid-b",
        AUTH_JWT_PUBLIC_KEY_SET: JSON.stringify({ keys: [keyB.jwk] }),
      });
      await expect(verifyAccessToken(oldToken, onlyNewKey)).rejects.toThrow(HttpError);
    });
  });

  describe("private key never leaks", () => {
    it("getPublicJwks never includes a private-key field ('d')", () => {
      const jwks = getPublicJwks(configA);
      for (const key of jwks.keys) {
        expect(key).not.toHaveProperty("d");
      }
    });

    it("the signed token itself contains no key material", async () => {
      const token = await signAccessToken({ sub: "user-1", sid: "session-1" }, configA);
      expect(token).not.toContain("PRIVATE KEY");
      expect(token.toLowerCase()).not.toContain(keyA.pem.slice(30, 60).toLowerCase());
    });
  });

  describe("config validation", () => {
    it("throws a clear error when own-auth key config is missing", async () => {
      const empty = baseConfig();
      await expect(signAccessToken({ sub: "u", sid: "s" }, empty)).rejects.toThrow(HttpError);
    });
  });
});
