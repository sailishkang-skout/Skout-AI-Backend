/**
 * Values a person types, pastes or sends into an input column (PRD 7.3.1).
 *
 * Two kinds of "wrong" are treated differently:
 *  - Something a cell cannot hold at all (an object, a list, an oversized or NUL-containing string) is refused.
 *  - A value that does not fit the column's type, such as a malformed email, is kept and **flagged**: the cell is
 *    stored with state `error` and an `invalid_<type>` error code, so nothing the user typed is lost.
 *
 * The column's type is `config.dataType`; a column without one is text. WB2-013 owns writing that config.
 */
export const INPUT_DATA_TYPES = ["text", "number", "email", "url", "linkedin_url", "domain", "phone", "date", "checkbox"] as const;
export type InputDataType = (typeof INPUT_DATA_TYPES)[number];

export const MAX_CELL_TEXT_LENGTH = 10_000;

export type CellScalar = string | number | boolean;

export type NormalizedCell =
  /** Nothing to store: the cell is cleared. */
  | { kind: "empty" }
  | { kind: "value"; value: CellScalar; errorCode: `invalid_${InputDataType}` | null }
  | { kind: "rejected"; reason: string };

export function inputDataType(config: unknown): InputDataType {
  const declared = (config as { dataType?: unknown } | null | undefined)?.dataType;
  return (INPUT_DATA_TYPES as readonly unknown[]).includes(declared) ? (declared as InputDataType) : "text";
}

const NUMBER = /^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/;
const EMAIL = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/;
const DOMAIN = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;
const PHONE = /^\+?[\d\s().-]+$/;
const DATE = /^(\d{4})-(\d{2})-(\d{2})(T([01]\d|2[0-3]):[0-5]\d(:[0-5]\d(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/;
const TRUE_WORDS = new Set(["true", "yes", "1"]);
const FALSE_WORDS = new Set(["false", "no", "0"]);

function webUrl(text: string): URL | null {
  try {
    const url = new URL(text);
    return (url.protocol === "http:" || url.protocol === "https:") && url.hostname.includes(".") ? url : null;
  } catch {
    return null;
  }
}

function isCalendarDate(text: string): boolean {
  const m = DATE.exec(text);
  if (!m) return false;
  const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const d = new Date(Date.UTC(year, month - 1, day));
  d.setUTCFullYear(year);
  return d.getUTCFullYear() === year && d.getUTCMonth() === month - 1 && d.getUTCDate() === day;
}

/** The value of a typed column if it fits, else null. */
function coerce(raw: CellScalar, type: InputDataType): CellScalar | null {
  if (type === "text") return String(raw);
  if (type === "checkbox") {
    if (typeof raw === "boolean") return raw;
    const word = String(raw).trim().toLowerCase();
    return TRUE_WORDS.has(word) ? true : FALSE_WORDS.has(word) ? false : null;
  }
  if (type === "number") {
    if (typeof raw === "number") return raw;
    if (typeof raw !== "string" || !NUMBER.test(raw.trim())) return null;
    const n = Number(raw.trim());
    return Number.isFinite(n) ? n : null;
  }
  if (typeof raw !== "string") return null;
  const text = raw.trim();
  switch (type) {
    case "email":
      return EMAIL.test(text) ? text : null;
    case "url":
      return webUrl(text) ? text : null;
    case "linkedin_url": {
      // People paste profile addresses without the scheme.
      const url = webUrl(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`);
      const onLinkedIn = url && (url.hostname === "linkedin.com" || url.hostname.endsWith(".linkedin.com"));
      return onLinkedIn && url.pathname.length > 1 ? text : null;
    }
    case "domain":
      return DOMAIN.test(text) ? text.toLowerCase() : null;
    case "phone": {
      const digits = text.replace(/\D/g, "").length;
      return PHONE.test(text) && digits >= 7 && digits <= 15 ? text : null;
    }
    case "date":
      return isCalendarDate(text) ? text : null;
  }
}

export function normalizeInputValue(raw: unknown, type: InputDataType): NormalizedCell {
  if (raw === null || raw === undefined) return { kind: "empty" };
  if (typeof raw === "string") {
    if (raw.length > MAX_CELL_TEXT_LENGTH) return { kind: "rejected", reason: `text is longer than ${MAX_CELL_TEXT_LENGTH} characters` };
    if (raw.includes("\u0000")) return { kind: "rejected", reason: "text must not contain a NUL character" };
    if (raw.trim() === "") return { kind: "empty" };
  } else if (typeof raw === "number") {
    if (!Number.isFinite(raw)) return { kind: "rejected", reason: "number must be finite" };
  } else if (typeof raw !== "boolean") {
    return { kind: "rejected", reason: "a cell holds text, a number, true/false or null" };
  }
  const value = coerce(raw as CellScalar, type);
  return value === null ? { kind: "value", value: raw as CellScalar, errorCode: `invalid_${type}` } : { kind: "value", value, errorCode: null };
}
