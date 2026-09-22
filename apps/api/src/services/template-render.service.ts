import { renderMergeTemplate } from "./merge-template.js";

export interface MergeData {
  firstName: string;
  lastName: string;
  fullName: string;
  companyName: string;
  companyDomain: string;
  title: string;
  senderName: string;
  senderEmail: string;
  unsubscribeUrl: string;
}

/**
 * Replaces `{{token}}` and `{{token|fallback}}` placeholders with values from `data`. A blank value
 * uses the fallback when there is one; otherwise a missing value renders as an empty string.
 */
export function renderTemplate(template: string, data: Partial<MergeData>): string {
  return renderMergeTemplate(template, data as Record<string, string | undefined>);
}
