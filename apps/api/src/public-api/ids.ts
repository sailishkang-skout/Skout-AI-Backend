import { createCipheriv, createDecipheriv, createHmac, hkdfSync } from "node:crypto";

/**
 * Public ids (PAPI-043, public API PRD CONV-8): every id the public API returns is prefixed and
 * opaque (per_, com_, job_, whk_). Internal UUIDs and provider ids never leave.
 *
 * An id is the internal id encrypted with AES-256-GCM under a type-specific key, with the IV taken
 * from an HMAC of the plaintext (a deterministic, SIV-style construction): the same record always
 * has the same public id, the id can be turned back into the internal one, and a tampered id or one
 * of another type fails to decode. Encoded as base64url.
 */
export const PUBLIC_ID_PREFIX = { person: "per", company: "com", job: "job", webhook: "whk", cursor: "cur" } as const;
export type PublicIdType = keyof typeof PUBLIC_ID_PREFIX;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEX64_RE = /^[0-9a-f]{64}$/i;
const FORM = { uuid: 1, hex64: 2, text: 3 } as const;

function pack(internalId: string): Buffer {
  if (UUID_RE.test(internalId)) return Buffer.concat([Buffer.from([FORM.uuid]), Buffer.from(internalId.replace(/-/g, ""), "hex")]);
  if (HEX64_RE.test(internalId)) return Buffer.concat([Buffer.from([FORM.hex64]), Buffer.from(internalId, "hex")]);
  return Buffer.concat([Buffer.from([FORM.text]), Buffer.from(internalId, "utf8")]);
}

function unpack(buf: Buffer): string | null {
  const form = buf[0];
  const body = buf.subarray(1);
  if (form === FORM.uuid && body.length === 16) {
    const h = body.toString("hex");
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
  }
  if (form === FORM.hex64 && body.length === 32) return body.toString("hex");
  if (form === FORM.text) return body.toString("utf8");
  return null;
}

export interface PublicIdCodec {
  encode(type: PublicIdType, internalId: string): string;
  /** The internal id, or null when the id is malformed, tampered with or of another type. */
  decode(type: PublicIdType, publicId: string): string | null;
}

/** `secret`: PUBLIC_API_ID_SECRET, else derived from API_KEY_PEPPER. Must stay stable: ids are stored by customers. */
export function createPublicIdCodec(secret: string): PublicIdCodec {
  if (!secret || secret.length < 16) throw new Error("Public id secret is missing or too short");
  const keys = new Map<PublicIdType, { enc: Buffer; mac: Buffer }>();
  const keysFor = (type: PublicIdType) => {
    let k = keys.get(type);
    if (!k) {
      const material = Buffer.from(hkdfSync("sha256", secret, "skout-public-id", `type:${type}`, 64));
      k = { enc: material.subarray(0, 32), mac: material.subarray(32) };
      keys.set(type, k);
    }
    return k;
  };
  return {
    encode(type, internalId) {
      const { enc, mac } = keysFor(type);
      const pt = pack(internalId);
      const iv = createHmac("sha256", mac).update(pt).digest().subarray(0, 12);
      const cipher = createCipheriv("aes-256-gcm", enc, iv);
      const ct = Buffer.concat([cipher.update(pt), cipher.final()]);
      return `${PUBLIC_ID_PREFIX[type]}_${Buffer.concat([iv, ct, cipher.getAuthTag()]).toString("base64url")}`;
    },
    decode(type, publicId) {
      const prefix = `${PUBLIC_ID_PREFIX[type]}_`;
      if (typeof publicId !== "string" || !publicId.startsWith(prefix) || publicId.length > 600) return null;
      const raw = Buffer.from(publicId.slice(prefix.length), "base64url");
      if (raw.length < 12 + 2 + 16) return null;
      const { enc, mac } = keysFor(type);
      try {
        const decipher = createDecipheriv("aes-256-gcm", enc, raw.subarray(0, 12));
        decipher.setAuthTag(raw.subarray(raw.length - 16));
        const pt = Buffer.concat([decipher.update(raw.subarray(12, raw.length - 16)), decipher.final()]);
        // The IV must be the one this plaintext produces, or the id was built some other way.
        if (!createHmac("sha256", mac).update(pt).digest().subarray(0, 12).equals(raw.subarray(0, 12))) return null;
        return unpack(pt);
      } catch {
        return null;
      }
    },
  };
}

/** The secret to use: PUBLIC_API_ID_SECRET, else one derived from the key pepper. */
export function publicIdSecret(cfg: { PUBLIC_API_ID_SECRET?: string; API_KEY_PEPPER?: string }): string | null {
  if (cfg.PUBLIC_API_ID_SECRET) return cfg.PUBLIC_API_ID_SECRET;
  if (cfg.API_KEY_PEPPER) return Buffer.from(hkdfSync("sha256", cfg.API_KEY_PEPPER, "skout-public-id-secret", "v1", 32)).toString("base64");
  return null;
}

// --- Leak guard ----------------------------------------------------------------------

/** Data providers whose names must never reach a customer (PRD §8.1, §9.5). */
export const PROVIDER_NAMES = [
  "wiza",
  "contactout",
  "datagma",
  "cognism",
  "lusha",
  "kaspr",
  "hunter",
  "zerobounce",
  "neverbounce",
  "millionverifier",
  "peopledatalabs",
  "pdl",
  "explorium",
  "coresignal",
  "revenuebase",
  "apollo",
  "unipile",
] as const;

const UUID_ANYWHERE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
/** Fields that name where data came from; provider names are checked only here, not in people's data. */
const SOURCE_FIELDS = /^(source|sources|provider|providers|vendor|vendors|data_source|origin|enriched_by|via)$/i;

/** Every place in a response body that leaks an internal UUID or a provider name (empty = clean). */
export function findInternalLeaks(body: unknown, path = "$"): string[] {
  const out: string[] = [];
  const visit = (v: unknown, p: string, sourceField: boolean) => {
    if (typeof v === "string") {
      if (UUID_ANYWHERE.test(v)) out.push(`${p}: internal id`);
      if (sourceField && PROVIDER_NAMES.some((n) => v.toLowerCase().includes(n))) out.push(`${p}: provider name`);
    } else if (Array.isArray(v)) {
      v.forEach((x, i) => visit(x, `${p}[${i}]`, sourceField));
    } else if (v && typeof v === "object") {
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
        if (UUID_ANYWHERE.test(k)) out.push(`${p}.${k}: internal id in a key`);
        if (PROVIDER_NAMES.some((n) => k.toLowerCase() === n)) out.push(`${p}.${k}: provider name as a key`);
        visit(x, `${p}.${k}`, SOURCE_FIELDS.test(k));
      }
    }
  };
  visit(body, path, false);
  return out;
}
