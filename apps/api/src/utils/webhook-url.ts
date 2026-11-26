import { isIP } from "node:net";

/**
 * Webhooks send customer data to another server, so the address must be public HTTPS: no
 * localhost, no private or link-local IPs, no internal hostnames (protects our own network).
 */
export function webhookUrlProblem(raw: string): string | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return "Must be a valid URL";
  }
  if (u.protocol !== "https:") return "Must start with https://";
  if (u.username || u.password) return "Must not contain a username or password";
  // A trailing dot names the same host ("localhost." is localhost), so it is removed before any check.
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.+$/, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal") || !host.includes(".")) {
    return "Must be a public address, not a local or internal one";
  }
  const v = isIP(host);
  if (v === 4) {
    const [a, b] = host.split(".").map(Number) as [number, number];
    if (a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127)) {
      return "Must be a public address, not a private IP";
    }
  }
  if (v === 6 && (host === "::1" || host.startsWith("fc") || host.startsWith("fd") || host.startsWith("fe80") || host.startsWith("::ffff:"))) {
    return "Must be a public address, not a private IP";
  }
  return null;
}
