/** Placeholder domains from the LinkedIn extension — not real company websites. */
export function isSyntheticCaptureDomain(domain: string): boolean {
  const d = domain
    .trim()
    .toLowerCase()
    .replace(/^www\./, "")
    .replace(/\/$/, "");
  return d.endsWith(".linkedin") || d === "linkedin-capture.local";
}

export function linkedinHandleFromUrl(url?: string): string | undefined {
  if (!url) return undefined;
  const match = url.match(/linkedin\.com\/(?:in|pub)\/([^/?#]+)/i);
  if (!match?.[1]) return undefined;
  return decodeURIComponent(match[1]).replace(/\/$/, "");
}
