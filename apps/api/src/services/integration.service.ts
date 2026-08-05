/** Integrations & BYOK — workspace API keys preferred before platform defaults. */

export interface IntegrationItem {
  provider: string;
  name: string;
  description: string;
  docsUrl: string;
  category?: "enrichment" | "messaging";
  connected: boolean;
  keyHint: string | null;
  status: string | null;
  lastValidatedAt: string | null;
  creditDiscount: string;
  dsnHint?: string | null;
}

const PROVISIONAL_PROVIDERS: Omit<IntegrationItem, "connected" | "keyHint" | "status" | "lastValidatedAt">[] = [
  {
    provider: "unipile",
    name: "Unipile",
    description:
      "Connect LinkedIn and WhatsApp for personalized, deliverable-first outreach at scale.",
    docsUrl: "https://www.unipile.com/",
    category: "messaging",
    creditDiscount: "Use Unipile for LinkedIn/WhatsApp messaging.",
    dsnHint: null,
  },
  {
    provider: "apollo",
    name: "Apollo",
    description:
      "Bring your own Apollo key for contact data enrichment. Your key is used before Skout platform defaults.",
    docsUrl: "https://www.apollo.io/",
    category: "enrichment",
    creditDiscount: "BYOK enrichment — 25% Skout credit discount.",
  },
  {
    provider: "hunter",
    name: "Hunter",
    description:
      "Bring your own Hunter key for email finding and verification. Workspace keys are preferred first.",
    docsUrl: "https://hunter.io/",
    category: "enrichment",
    creditDiscount: "BYOK enrichment — 25% Skout credit discount.",
  },
  {
    provider: "clearbit",
    name: "Clearbit",
    description:
      "Bring your own Clearbit key for company and person enrichment before platform defaults.",
    docsUrl: "https://clearbit.com/",
    category: "enrichment",
    creditDiscount: "BYOK enrichment — 25% Skout credit discount.",
  },
];

/** In-memory workspace → provider → stored key (dev/MVP). Swap for pgcrypto + RLS later. */
const STORED_KEYS = new Map<string, Map<string, string>>();

export class IntegrationService {
  async list(workspaceId: string): Promise<IntegrationItem[]> {
    const keys = STORED_KEYS.get(workspaceId) ?? new Map<string, string>();
    return PROVISIONAL_PROVIDERS.map((p) => {
      const key = keys.get(p.provider);
      return {
        ...p,
        connected: Boolean(key),
        keyHint: key ? maskKey(key) : null,
        status: key ? "valid" : null,
        lastValidatedAt: key ? new Date().toISOString() : null,
      };
    });
  }

  async save(workspaceId: string, provider: string, apiKey: string, dsn?: string): Promise<IntegrationItem> {
    const known = PROVISIONAL_PROVIDERS.find((p) => p.provider === provider);
    if (!known) {
      throw new Error(`Unknown integration provider: ${provider}`);
    }
    if (!apiKey || apiKey.length < 8) {
      throw new Error("API key must be at least 8 characters");
    }
    let keys = STORED_KEYS.get(workspaceId);
    if (!keys) {
      keys = new Map<string, string>();
      STORED_KEYS.set(workspaceId, keys);
    }
    keys.set(provider, apiKey);
    const item: IntegrationItem = {
      ...known,
      connected: true,
      keyHint: maskKey(apiKey),
      status: "valid",
      lastValidatedAt: new Date().toISOString(),
      dsnHint: dsn ?? known.dsnHint,
    };
    return item;
  }

  async remove(workspaceId: string, provider: string): Promise<void> {
    const keys = STORED_KEYS.get(workspaceId);
    if (keys) {
      keys.delete(provider);
    }
  }

  async test(workspaceId: string, provider: string, apiKey?: string, dsn?: string): Promise<{ ok: true }> {
    const known = PROVISIONAL_PROVIDERS.find((p) => p.provider === provider);
    if (!known) {
      throw new Error(`Unknown integration provider: ${provider}`);
    }
    const keys = STORED_KEYS.get(workspaceId);
    const key = apiKey ?? keys?.get(provider);
    if (!key) {
      throw new Error("No API key stored for this provider");
    }
    if (key.length < 8) {
      throw new Error("API key must be at least 8 characters");
    }
    // Stub validation — real providers would make a test call here.
    return { ok: true };
  }
}

function maskKey(key: string): string {
  if (key.length <= 8) return "••••••••";
  return `${key.slice(0, 4)}••••${key.slice(-4)}`;
}

export const integrationService = new IntegrationService();
