/** Pino redact paths — secrets never appear in CloudWatch / log forwarders. */
export const LOG_REDACT_PATHS = [
  "authorization",
  "req.headers.authorization",
  "headers.authorization",
  // AUTH-BE-14 — the refresh-token cookie must never be logged, same reasoning as the
  // Authorization header above (it is the raw, pre-hash credential).
  "cookie",
  "req.headers.cookie",
  "headers.cookie",
  "set-cookie",
  "req.headers['set-cookie']",
  "headers['set-cookie']",
  "*.password",
  "*.refreshCookie",
  "*.secret",
  "*.apiKey",
  "*.api_key",
  "*.token",
  "*.otp",
  "*.code",
  "*.inviteToken",
  "*.sessionToken",
  "*.codeVerifier",
  "*.code_verifier",
  "*.idToken",
  "*.id_token",
  "*.accessToken",
  "*.refreshToken",
  "*.clientSecret",
  "*.encryptionKey",
  "*.authorization",
  "*.Authorization",
  "INTEGRATION_ENCRYPTION_KEY",
  "HUBSPOT_CLIENT_SECRET",
  "GOOGLE_OAUTH_CLIENT_SECRET",
  "MICROSOFT_OAUTH_CLIENT_SECRET",
  "CLERK_SECRET_KEY",
  "OPENAI_API_KEY",
  "DATABASE_PASSWORD",
  "DATABASE_URL",
] as const;

/**
 * API keys by value (PAPI-026, public API PRD §9.1): sk_live_ / sk_test_ public keys and sk_cops_
 * keys, wherever they appear — a URL, an error message, a nested field. Path-based redaction above
 * only covers known field names, so every finished log line also goes through `scrubSecrets`.
 */
export const API_KEY_VALUE_PATTERN = /sk_(live|test|cops)_[A-Za-z0-9_-]+/g;

/** Replaces every API key in `text` with `sk_<type>_[REDACTED]`. */
export function scrubSecrets(text: string): string {
  return text.includes("sk_") ? text.replace(API_KEY_VALUE_PATTERN, "sk_$1_[REDACTED]") : text;
}

/** Deep-scrubs a JSON-serialisable value (e.g. an error-report event); returns the input if it can't be serialised. */
export function scrubSecretsDeep<T>(value: T): T {
  try {
    const json = JSON.stringify(value);
    if (json === undefined || !json.includes("sk_")) return value;
    return JSON.parse(scrubSecrets(json)) as T;
  } catch {
    return value;
  }
}
