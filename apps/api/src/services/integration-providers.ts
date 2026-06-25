import type { PalConfig } from "@skout/pal";

/** Supported BYOK enrichment providers (slug → PAL config field). */
export const INTEGRATION_PROVIDERS = [
  {
    id: "hunter",
    name: "Hunter.io",
    description: "Email finder and verifier",
    palKey: "hunterApiKey" as const,
    docsUrl: "https://hunter.io/api-keys",
  },
  {
    id: "millionverifier",
    name: "MillionVerifier",
    description: "Bulk email verification",
    palKey: "millionVerifierApiKey" as const,
    docsUrl: "https://app.millionverifier.com/api",
  },
  {
    id: "zerobounce",
    name: "ZeroBounce",
    description: "Email validation accuracy gate",
    palKey: "zeroBounceApiKey" as const,
    docsUrl: "https://www.zerobounce.net/members/apikey",
  },
  {
    id: "neverbounce",
    name: "NeverBounce",
    description: "Email verification",
    palKey: "neverBounceApiKey" as const,
    docsUrl: "https://app.neverbounce.com/apps/console",
  },
  {
    id: "pdl",
    name: "People Data Labs",
    description: "Company firmographics",
    palKey: "pdlApiKey" as const,
    docsUrl: "https://dashboard.peopledatalabs.com/api-keys",
  },
  {
    id: "datagma",
    name: "Datagma",
    description: "Phone enrichment",
    palKey: "datagmaApiKey" as const,
    docsUrl: "https://datagma.com",
  },
  {
    id: "kaspr",
    name: "Kaspr",
    description: "EU phone enrichment",
    palKey: "kasprApiKey" as const,
    docsUrl: "https://www.kaspr.io",
  },
  {
    id: "lusha",
    name: "Lusha",
    description: "Phone enrichment (ISO 27701)",
    palKey: "lushaApiKey" as const,
    docsUrl: "https://www.lusha.com",
  },
  {
    id: "contactout",
    name: "ContactOut",
    description: "Phone enrichment fallback",
    palKey: "contactOutApiKey" as const,
    docsUrl: "https://contactout.com/api",
  },
] as const;

export type IntegrationProviderId = (typeof INTEGRATION_PROVIDERS)[number]["id"];

export function isIntegrationProviderId(value: string): value is IntegrationProviderId {
  return INTEGRATION_PROVIDERS.some((p) => p.id === value);
}

export function palConfigFromIntegrations(
  keys: Partial<Record<IntegrationProviderId, string>>
): Partial<PalConfig> {
  const cfg: Partial<PalConfig> = {};
  for (const meta of INTEGRATION_PROVIDERS) {
    const key = keys[meta.id];
    if (key?.trim()) {
      (cfg as Record<string, string>)[meta.palKey] = key.trim();
    }
  }
  return cfg;
}

export function hasWorkspacePalKeys(cfg: Partial<PalConfig>): boolean {
  return INTEGRATION_PROVIDERS.some((p) => {
    const v = (cfg as Record<string, string | undefined>)[p.palKey];
    return Boolean(v?.trim());
  });
}
