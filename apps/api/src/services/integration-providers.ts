import type { PalConfig } from "@skout/pal";

type EnrichmentProvider = {
  id: string;
  name: string;
  description: string;
  category: "enrichment";
  palKey: keyof PalConfig & string;
  docsUrl: string;
};

type MessagingProvider = {
  id: string;
  name: string;
  description: string;
  category: "messaging";
  docsUrl: string;
};

/** Supported workspace BYOK integrations. */
export const INTEGRATION_PROVIDERS = [
  {
    id: "hunter",
    name: "Hunter.io",
    description: "Email finder and verifier",
    category: "enrichment",
    palKey: "hunterApiKey",
    docsUrl: "https://hunter.io/api-keys",
  },
  {
    id: "millionverifier",
    name: "MillionVerifier",
    description: "Bulk email verification",
    category: "enrichment",
    palKey: "millionVerifierApiKey",
    docsUrl: "https://app.millionverifier.com/api",
  },
  {
    id: "zerobounce",
    name: "ZeroBounce",
    description: "Email validation accuracy gate",
    category: "enrichment",
    palKey: "zeroBounceApiKey",
    docsUrl: "https://www.zerobounce.net/members/apikey",
  },
  {
    id: "neverbounce",
    name: "NeverBounce",
    description: "Email verification",
    category: "enrichment",
    palKey: "neverBounceApiKey",
    docsUrl: "https://app.neverbounce.com/apps/console",
  },
  {
    id: "pdl",
    name: "People Data Labs",
    description: "Company firmographics",
    category: "enrichment",
    palKey: "pdlApiKey",
    docsUrl: "https://dashboard.peopledatalabs.com/api-keys",
  },
  {
    id: "datagma",
    name: "Datagma",
    description: "Phone enrichment",
    category: "enrichment",
    palKey: "datagmaApiKey",
    docsUrl: "https://datagma.com",
  },
  {
    id: "kaspr",
    name: "Kaspr",
    description: "EU phone enrichment",
    category: "enrichment",
    palKey: "kasprApiKey",
    docsUrl: "https://www.kaspr.io",
  },
  {
    id: "lusha",
    name: "Lusha",
    description: "Phone enrichment (ISO 27701)",
    category: "enrichment",
    palKey: "lushaApiKey",
    docsUrl: "https://www.lusha.com",
  },
  {
    id: "contactout",
    name: "ContactOut",
    description: "Phone enrichment fallback",
    category: "enrichment",
    palKey: "contactOutApiKey",
    docsUrl: "https://contactout.com/api",
  },
  {
    id: "unipile",
    name: "Unipile",
    description: "LinkedIn and WhatsApp outreach for sequences and Deliverability",
    category: "messaging",
    docsUrl: "https://dashboard.unipile.com",
  },
] as const satisfies readonly (EnrichmentProvider | MessagingProvider)[];

export type IntegrationProviderId = (typeof INTEGRATION_PROVIDERS)[number]["id"];

export function isIntegrationProviderId(value: string): value is IntegrationProviderId {
  return INTEGRATION_PROVIDERS.some((p) => p.id === value);
}

export function getIntegrationMeta(id: IntegrationProviderId) {
  return INTEGRATION_PROVIDERS.find((p) => p.id === id)!;
}

export function palConfigFromIntegrations(
  keys: Partial<Record<IntegrationProviderId, string>>
): Partial<PalConfig> {
  const cfg: Partial<PalConfig> = {};
  for (const meta of INTEGRATION_PROVIDERS) {
    if (meta.category !== "enrichment") continue;
    const key = keys[meta.id];
    if (key?.trim()) {
      (cfg as Record<string, string>)[meta.palKey] = key.trim();
    }
  }
  return cfg;
}

export function hasWorkspacePalKeys(cfg: Partial<PalConfig>): boolean {
  return INTEGRATION_PROVIDERS.some((p) => {
    if (p.category !== "enrichment") return false;
    const v = (cfg as Record<string, string | undefined>)[p.palKey];
    return Boolean(v?.trim());
  });
}

export const DEFAULT_UNIPILE_DSN = "https://api1.unipile.com:13111";
