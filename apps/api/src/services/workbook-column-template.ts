/**
 * §8.3 Task ADI-12 — the "derived field" / "ai_research" template engine. Deliberately just
 * `{{key}}` string substitution, not a formula language — see the design doc's §6 "not in
 * scope" list (arithmetic, conditionals, functions, cross-row aggregation are all explicit
 * non-goals for this cut).
 */

const TEMPLATE_KEY_RE = /\{\{(\w+)\}\}/g;

/** Every distinct `{{key}}` referenced in a template, in first-appearance order. */
export function extractTemplateKeys(template: string): string[] {
  const seen = new Set<string>();
  const keys: string[] = [];
  for (const match of template.matchAll(TEMPLATE_KEY_RE)) {
    const key = match[1]!;
    if (!seen.has(key)) {
      seen.add(key);
      keys.push(key);
    }
  }
  return keys;
}

export interface RenderTemplateResult {
  rendered: string;
  /** Keys referenced in the template with no entry (or an undefined/null entry) in context. */
  missingKeys: string[];
}

/**
 * Substitutes every `{{key}}` in `template` with `context[key]`. A missing/undefined/null
 * context value is substituted as an empty string (not left as literal `{{key}}` text) and
 * reported in `missingKeys`, so the caller can decide whether that's a hard failure (e.g. an
 * ai_research prompt with a missing reference probably shouldn't fire) without the template
 * engine itself needing to know column-type-specific policy.
 */
export function renderTemplate(template: string, context: Record<string, string | undefined | null>): RenderTemplateResult {
  const missingKeys: string[] = [];
  const rendered = template.replace(TEMPLATE_KEY_RE, (_match, key: string) => {
    const value = context[key];
    if (value == null) {
      missingKeys.push(key);
      return "";
    }
    return value;
  });
  return { rendered, missingKeys };
}
