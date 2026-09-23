#!/usr/bin/env tsx
/**
 * Generates own-auth signing material (AUTH-ADI-09): an RS256 keypair for access-token signing
 * plus a refresh-token pepper and a cookie secret. No AWS access needed.
 *
 * The key format is dictated by the signer (apps/api/src/services/token.service.ts calls
 * `importPKCS8(pem, "RS256")`): the private key must be a PKCS8 PEM and the JWKS entry must
 * carry `alg: "RS256"`. Keep this script in step with that file.
 *
 * Local dev: run with no arguments and paste the printed block into your .env (or use
 * apps/api/scripts/generate-local-auth-keys.mjs, which does the same for the key alone).
 *
 * Deployed environments: run with --json, then put the five fields into the
 * `{Prefix}/auth` secret in Secrets Manager (see docs/secrets-rotation-policy.md for the
 * rotation procedure — never reuse a value across environments). The PEM keeps its real
 * newlines inside the JSON string, which is what the container needs.
 *
 * Run: pnpm --filter @skout/infra generate-auth-keys [--json]
 */
import { createPublicKey, generateKeyPairSync, randomBytes } from "node:crypto";

const kid = `auth-${randomBytes(4).toString("hex")}`;

const { publicKey, privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});

const publicJwk = {
  ...createPublicKey(publicKey).export({ format: "jwk" }),
  kid,
  alg: "RS256",
  use: "sig",
};

const fields = {
  AUTH_JWT_PRIVATE_KEY: privateKey,
  AUTH_JWT_KID: kid,
  // Two published keys support rotation (BE-12) — this run only produces one; append the
  // previous key's public JWK to the `keys` array here when rotating instead of replacing it.
  AUTH_JWT_PUBLIC_KEY_SET: JSON.stringify({ keys: [publicJwk] }),
  AUTH_REFRESH_TOKEN_PEPPER: randomBytes(32).toString("base64"),
  AUTH_COOKIE_SECRET: randomBytes(32).toString("base64"),
};

if (process.argv.includes("--json")) {
  console.log(JSON.stringify(fields, null, 2));
} else {
  console.log("# Own-auth signing material — paste into apps/api's .env for local dev.");
  console.log("# Generate a fresh set per environment; never reuse across dev/UAT/prod.");
  for (const [key, value] of Object.entries(fields)) {
    // .env values can't hold raw newlines; dotenv expands \n inside double quotes.
    const escaped = value.replace(/\n/g, "\\n");
    console.log(key === "AUTH_JWT_PRIVATE_KEY" ? `${key}="${escaped}"` : `${key}='${escaped}'`);
  }
}
