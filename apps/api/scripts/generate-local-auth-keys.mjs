#!/usr/bin/env node
/**
 * AUTH-BE-12 — local dev key generator for own-auth JWTs. No AWS needed (AUTH-ADI-09
 * provisions the real per-environment secrets in Secrets Manager; this is the "Sahils never
 * need AWS keys locally" escape hatch the ticket asks for).
 *
 * Generates one RS256 keypair, prints ready-to-paste .env lines: the private key (PKCS8 PEM,
 * single-lined with \n escapes so it fits a .env value), a kid, and a JWKS containing just that
 * one public key. Re-run this to rotate locally — two calls give you two kids, which you can
 * both keep in AUTH_JWT_PUBLIC_KEY_SET during a manual rotation test (AUTH-BE-12's rotation
 * acceptance criterion: old key still verifies while both are published).
 *
 * Usage: node scripts/generate-local-auth-keys.mjs [--kid <name>]
 */
import { generateKeyPair, exportPKCS8, exportJWK } from "jose";
import { randomUUID } from "node:crypto";

const kidArgIndex = process.argv.indexOf("--kid");
const kid = kidArgIndex !== -1 ? process.argv[kidArgIndex + 1] : `local-${randomUUID().slice(0, 8)}`;

const { publicKey, privateKey } = await generateKeyPair("RS256", { modulusLength: 2048, extractable: true });

const privatePem = await exportPKCS8(privateKey);
const publicJwk = await exportJWK(publicKey);
publicJwk.kid = kid;
publicJwk.alg = "RS256";
publicJwk.use = "sig";

const jwks = { keys: [publicJwk] };

console.log("# Paste into your .env (apps/api). Existing AUTH_JWT_PUBLIC_KEY_SET keys are NOT");
console.log("# preserved here — if you're rotating, merge this key's JWK into the existing keys array.");
console.log("");
console.log(`AUTH_JWT_KID=${kid}`);
console.log(`AUTH_JWT_PRIVATE_KEY="${privatePem.replace(/\n/g, "\\n")}"`);
console.log(`AUTH_JWT_PUBLIC_KEY_SET='${JSON.stringify(jwks)}'`);
