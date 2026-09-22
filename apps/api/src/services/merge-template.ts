/**
 * The merge-token grammar, defined once for everything that reads sequence copy.
 *
 *   {{token}}            replaced with the recipient's value
 *   {{token|fallback}}   same, but `fallback` is used when the value is blank
 *
 * A fallback is 1-60 characters, with no `{`, `}`, `|` or line breaks. Anything else that looks
 * like `{{…}}` is "malformed": it is left as literal text when rendering and reported by
 * `findMergeTemplateIssue` so it can be rejected before it is saved.
 */
export const FALLBACK_MAX = 60;

/** A valid token: a word, optionally followed by `|` and a fallback. */
const TOKEN_RE = /\{\{(\w+)(?:\|([^{}|\r\n]*))?\}\}/g;
/** Anything shaped like a token attempt, valid or not. */
const ATTEMPT_RE = /\{\{([^{}]*)\}\}/g;
/** What the inside of a valid token looks like. */
const INNER_RE = /^(\w+)(?:\|([^{}|\r\n]*))?$/;

/** Tokens that must never carry a fallback. */
const NO_FALLBACK: ReadonlySet<string> = new Set(["unsubscribeUrl"]);

export interface MergeToken {
  name: string;
  /** Trimmed fallback text, or null for a plain token. */
  fallback: string | null;
  raw: string;
  index: number;
}

/** The valid tokens in `text`, in order. Malformed placeholders are not returned. */
export function parseMergeTokens(text: string): MergeToken[] {
  return [...text.matchAll(TOKEN_RE)].map((m) => ({
    name: m[1]!,
    fallback: m[2] === undefined ? null : m[2].trim(),
    raw: m[0],
    index: m.index ?? 0,
  }));
}

/**
 * Fills tokens from `data`. A blank value (missing, empty or whitespace) uses the token's
 * fallback when it has one; without a fallback the value is used as-is and a missing value
 * renders as an empty string, exactly as before fallbacks existed.
 */
export function renderMergeTemplate(template: string, data: Readonly<Record<string, string | undefined>>): string {
  return template.replace(TOKEN_RE, (_match, name: string, fallback: string | undefined) => {
    const value = data[name];
    if (fallback !== undefined && (value === undefined || value.trim() === "")) return fallback.trim();
    return value ?? "";
  });
}

export type MergeIssueCode =
  | "unknown_token"
  | "malformed_token"
  | "empty_fallback"
  | "fallback_too_long"
  | "fallback_not_allowed";

export interface MergeTemplateIssue {
  code: MergeIssueCode;
  /** The token name, or the raw placeholder for a malformed one. */
  token: string;
  message: string;
}

/** The first problem in `text`, in reading order, or null when every placeholder is valid. */
export function findMergeTemplateIssue(text: string, allowed: ReadonlySet<string>): MergeTemplateIssue | null {
  for (const attempt of text.matchAll(ATTEMPT_RE)) {
    const inner = INNER_RE.exec(attempt[1]!);
    if (!inner) {
      return { code: "malformed_token", token: attempt[0], message: `Malformed merge token: ${attempt[0]}` };
    }
    const name = inner[1]!;
    if (!allowed.has(name)) {
      return { code: "unknown_token", token: name, message: `Unknown merge token: {{${name}}}` };
    }
    const fallback = inner[2];
    if (fallback === undefined) continue;
    if (NO_FALLBACK.has(name)) {
      return { code: "fallback_not_allowed", token: name, message: `{{${name}}} can't have a fallback` };
    }
    const trimmed = fallback.trim();
    if (trimmed.length === 0) {
      return { code: "empty_fallback", token: name, message: `Fallback for {{${name}}} is empty` };
    }
    if (trimmed.length > FALLBACK_MAX) {
      return {
        code: "fallback_too_long",
        token: name,
        message: `Fallback for {{${name}}} is longer than ${FALLBACK_MAX} characters`,
      };
    }
  }
  return null;
}
