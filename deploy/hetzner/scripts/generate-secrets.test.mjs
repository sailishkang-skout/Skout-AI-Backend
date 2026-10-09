import { test } from "node:test";
import assert from "node:assert/strict";
import { deriveClerkIssuer, generateSecrets } from "./generate-secrets.mjs";

const pk = (prefix, host) => `${prefix}_${Buffer.from(`${host}$`).toString("base64")}`;

test("deriveClerkIssuer decodes the frontend API host out of a Clerk publishable key", () => {
  assert.equal(deriveClerkIssuer(pk("pk_test", "tidy-lark-12.clerk.accounts.dev")), "https://tidy-lark-12.clerk.accounts.dev");
  assert.equal(deriveClerkIssuer(pk("pk_live", "clerk.skoutai.io")), "https://clerk.skoutai.io");
});

test("deriveClerkIssuer rejects anything that is not a publishable key", () => {
  assert.throws(() => deriveClerkIssuer("sk_test_abc"), /publishable key/i);
  assert.throws(() => deriveClerkIssuer(""), /publishable key/i);
  assert.throws(() => deriveClerkIssuer("pk_test_!!!notbase64"), /publishable key/i);
});

function counterHex() {
  let n = 0;
  return (bytes) => String(++n).padStart(bytes * 2, "0");
}

const authFields = {
  AUTH_JWT_PRIVATE_KEY: "-----BEGIN PRIVATE KEY-----\nx\n-----END PRIVATE KEY-----\n",
  AUTH_JWT_KID: "auth-1234",
  AUTH_JWT_PUBLIC_KEY_SET: '{"keys":[]}',
  AUTH_REFRESH_TOKEN_PEPPER: "pepper",
  AUTH_COOKIE_SECRET: "cookie",
};

test("generateSecrets passes the own-auth material through untouched", () => {
  const s = generateSecrets({ randomHex: counterHex(), authFields });
  for (const [k, v] of Object.entries(authFields)) assert.equal(s[k], v);
});

test("generateSecrets shares one provisioning key between the api and the warm-up tool", () => {
  const s = generateSecrets({ randomHex: counterHex(), authFields });
  assert.ok(s.PLATFORM_PROVISIONING_KEY);
  assert.equal(s.PLATFORM_PROVISIONING_KEY, s.WARMUP_TOOL_PLATFORM_PROVISIONING_KEY);
});

test("generateSecrets shares one evidence token between email-intel and the api, and points at the api over the overlay network", () => {
  const s = generateSecrets({ randomHex: counterHex(), authFields });
  assert.equal(s.SKOUT_CANONICAL_EVIDENCE_TOKEN, s.EMAIL_INTEL_EXTERNAL_API_KEY);
  assert.equal(s.SKOUT_CANONICAL_EVIDENCE_URL, "http://api:3001");
});

test("generateSecrets makes independent warm-up secrets of at least 32 characters", () => {
  const s = generateSecrets({ randomHex: (n) => "a".repeat(n * 2).slice(0, n * 2), authFields });
  assert.ok(s.ENCRYPTION_KEY.length >= 32);
  assert.ok(s.API_KEY_PEPPER.length >= 32);
  const d = generateSecrets({ randomHex: counterHex(), authFields });
  const unique = new Set([d.ENCRYPTION_KEY, d.API_KEY_PEPPER, d.PLATFORM_PROVISIONING_KEY, d.SKOUT_CANONICAL_EVIDENCE_TOKEN, d.MEETING_BOT_WEBHOOK_SECRET]);
  assert.equal(unique.size, 5, "independent secrets must not repeat");
});

test("generateSecrets sets the Postmark sender address", () => {
  assert.equal(generateSecrets({ randomHex: counterHex(), authFields }).SES_FROM_EMAIL, "noreply@skoutai.io");
});
