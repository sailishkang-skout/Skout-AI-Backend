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

/** Replaces `{{token}}` placeholders with values from `data`; unknown tokens render as empty string. */
export function renderTemplate(template: string, data: Partial<MergeData>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_match, key: string) => {
    const value = (data as Record<string, string | undefined>)[key];
    return value ?? "";
  });
}
