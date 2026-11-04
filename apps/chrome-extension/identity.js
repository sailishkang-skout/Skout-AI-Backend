/** Resolve the same stable identity used by reviewed LinkedIn profile captures. */
export function linkedinProfileId(linkedinUrl) {
  try {
    const url = new URL(linkedinUrl);
    if (url.protocol !== "https:" || !["www.linkedin.com", "linkedin.com"].includes(url.hostname)) {
      return undefined;
    }
    const match = url.pathname.match(/^\/in\/([^/]+)\/?$/i);
    if (!match) return undefined;
    const id = decodeURIComponent(match[1]).trim().toLowerCase();
    return id && !/[/?#\\\s\u0000-\u001f\u007f]/.test(id) ? id : undefined;
  } catch {
    return undefined;
  }
}

export async function canonicalLinkedinProspectId(linkedinUrl) {
  const publicId = linkedinProfileId(linkedinUrl);
  if (!publicId) return undefined;
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`linkedin:in:${publicId}`)
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
