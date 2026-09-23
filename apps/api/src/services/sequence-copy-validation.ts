import { HttpError } from "../utils/http.js";
import { findMergeTemplateIssue } from "./merge-template.js";
import { MERGE_TOKENS } from "./sequence-merge-tokens.js";

export interface StepCopy {
  subject?: string | null;
  bodyTemplate?: string | null;
  variants?: { subject?: string | null; bodyTemplate?: string | null }[];
}

/**
 * Rejects (422) the first invalid merge placeholder in any copy field a step saves: its own subject
 * and body, and every variant's. The message names the offending token so the editor can show it.
 */
export function assertValidStepCopy(copy: StepCopy): void {
  const fields = [
    copy.subject,
    copy.bodyTemplate,
    ...(copy.variants ?? []).flatMap((v) => [v.subject, v.bodyTemplate]),
  ];
  for (const text of fields) {
    if (!text) continue;
    const issue = findMergeTemplateIssue(text, MERGE_TOKENS);
    if (issue) {
      throw new HttpError(issue.message, 422, {
        invalidToken: issue.token,
        reason: issue.code,
        allowed: [...MERGE_TOKENS],
      });
    }
  }
}
