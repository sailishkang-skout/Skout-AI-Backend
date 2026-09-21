/** Merge tokens the sequence API accepts in step subjects/bodies (anything else is a 422). */
export const MERGE_TOKENS: ReadonlySet<string> = new Set([
  "firstName", "lastName", "fullName", "companyName", "companyDomain",
  "title", "senderName", "senderEmail", "unsubscribeUrl",
]);
