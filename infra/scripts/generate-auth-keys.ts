#!/usr/bin/env tsx
/**
 * Generates own-auth signing material (AUTH-ADI-09): an Ed25519 keypair for access-token
 * signing plus a refresh-token pepper and a cookie secret. No AWS access needed.
 *
 * Local dev: run with no arguments and paste the printed block into your .env — the Sahils
 * never need AWS keys locally.
 *
 * Deployed environments: run with --json, then put the five fields into the
 * `{Prefix}/auth` secret in Secrets Manager (see docs/secrets-rotation-policy.md for the
 * rotation procedure — never reuse a value across environments).
 *
 * Run: pnpm --filter @skout/infra generate-auth-keys [--json]
 */
import { generateKeyPairSync, randomBytes } from "node:crypto";

function newKid(): string {
  return randomBytes(6).toString("hex");
}

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const kid = newKid();

const privateJwk = { ...privateKey.export({ format: "jwk" }), kid, alg: "EdDSA", use: "sig" };
const publicJwk = { ...publicKey.export({ format: "jwk" }), kid, alg: "EdDSA", use: "sig" };

const fields = {
  AUTH_JWT_PRIVATE_KEY: JSON.stringify(privateJwk),
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
    console.log(`${key}='${value}'`);
  }
}
