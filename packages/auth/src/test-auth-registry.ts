import type { AuthProvider } from "./auth-provider.js";

const providersByIssuer = new Map<string, AuthProvider>();

/** Register a test-only provider for a JWT issuer (used by Vitest, not production). */
export function registerTestAuthProvider(issuer: string, provider: AuthProvider): void {
  providersByIssuer.set(issuer, provider);
}

export function getTestAuthProvider(issuer: string): AuthProvider | undefined {
  return providersByIssuer.get(issuer);
}

export function resetTestAuthProviders(): void {
  providersByIssuer.clear();
}
