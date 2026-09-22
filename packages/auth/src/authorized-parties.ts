/** Normalize an origin for Clerk `authorizedParties` (azp) allowlisting. */
export function normalizeOrigin(origin: string): string {
  try {
    const url = new URL(origin);
    url.hostname = url.hostname.toLowerCase();
    return url.origin;
  } catch {
    return origin.toLowerCase();
  }
}

export type AuthorizedPartiesConfig = {
  corsOrigin: string[];
  frontendUrl?: string;
};

/** Single source for Clerk session JWT `authorizedParties` (apps/api + step-up + CRM). */
export function computeAuthorizedParties(config: AuthorizedPartiesConfig): string[] {
  return [
    ...config.corsOrigin.map(normalizeOrigin),
    ...(config.frontendUrl ? [normalizeOrigin(config.frontendUrl)] : []),
    "http://localhost:3000",
    "http://127.0.0.1:3000",
  ].filter((value, index, all) => all.indexOf(value) === index);
}
