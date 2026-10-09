import { createHash } from "node:crypto";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Fixed namespace for audit ids derived from non-UUID entity ids (prospect ids are text, ADR 0001).
const AUDIT_NAMESPACE = "6b3f1c2e-8d4a-5e9b-a7c1-2f0d3e4b5a69";

/**
 * audit_logs.entity_id is a uuid column, but some entities (prospects) have text ids. A text id is
 * mapped to a deterministic UUID v5, so every audit row for the same entity shares one id; callers
 * also keep the original id in the audit after_state. UUID ids pass through unchanged.
 */
export function auditEntityId(id: string): string {
  if (UUID_RE.test(id)) return id.toLowerCase();
  const ns = Buffer.from(AUDIT_NAMESPACE.replace(/-/g, ""), "hex");
  const hash = createHash("sha1").update(Buffer.concat([ns, Buffer.from(id, "utf8")])).digest();
  const b = Buffer.from(hash.subarray(0, 16));
  b[6] = (b[6]! & 0x0f) | 0x50; // version 5
  b[8] = (b[8]! & 0x3f) | 0x80; // RFC 4122 variant
  const h = b.toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
