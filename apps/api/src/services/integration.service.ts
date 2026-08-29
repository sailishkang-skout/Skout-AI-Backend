import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { Db } from "@skout/db";
import { schema } from "@skout/db";
import { createLogger } from "@skout/observability";
import type { Env } from "../config/env.js";
import { HttpError } from "../utils/http.js";
import { decryptSecretWithFallback, encryptSecret, maskApiKey } from "@skout/shared";
import {
  DEFAULT_UNIPILE_DSN,
  INTEGRATION_PROVIDERS,
  isIntegrationProviderId,
  palConfigFromIntegrations,
  type IntegrationProviderId,
} from "./integration-providers.js";

const log = createLogger("integration.service");
const { workspaceIntegrations } = schema;

/**
 * Unipile's own dashboard displays the DSN without a scheme (e.g.
 * `api61.unipile.com:19183`), so users naturally paste it that way — but
 * `fetch()` requires an absolute URL. Without this, a schemeless DSN throws
 * on the ping request and surfaces as an opaque `provider_validation_failed`.
 */
export function normalizeUnipileDsn(dsn: string): string {
  const trimmed = dsn.trim().replace(/\/$/, "");
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

export interface IntegrationDto {
  provider: IntegrationProviderId;
  name: string;
  description: string;
  docsUrl: string;
  category: "enrichment" | "messaging" | "gtm_import";
  connected: boolean;
  keyHint: string | null;
  status: string | null;
  lastValidatedAt: string | null;
  creditDiscount: string;
  /** Optional Unipile DSN hint when connected */
  dsnHint?: string | null;
}

export class IntegrationService {
  constructor(
    private readonly db: Db | null,
    private readonly config: Env
  ) {}

  private get encryptionSecret(): string {
    return (
      this.config.INTEGRATION_ENCRYPTION_KEY ??
      this.config.CLERK_SECRET_KEY ??
      "dev-integration-encryption-key-change-me"
    );
  }

  private get previousEncryptionSecret(): string | undefined {
    return this.config.INTEGRATION_ENCRYPTION_KEY_PREVIOUS;
  }

  private decryptStored(payload: string): string {
    return decryptSecretWithFallback(payload, this.encryptionSecret, this.previousEncryptionSecret);
  }

  async list(workspaceId: string): Promise<{ workspaceId: string; data: IntegrationDto[] }> {
    const rows = this.db
      ? await this.db
          .select()
          .from(workspaceIntegrations)
          .where(eq(workspaceIntegrations.workspaceId, workspaceId))
      : [];

    const byProvider = new Map(rows.map((r) => [r.provider, r]));

    const data = INTEGRATION_PROVIDERS.map((meta) => {
      const row = byProvider.get(meta.id);
      let dsnHint: string | null = null;
      if (meta.id === "unipile" && row?.encryptedApiKey) {
        try {
          const parsed = JSON.parse(this.decryptStored(row.encryptedApiKey)) as {
            dsn?: string;
          };
          if (parsed?.dsn) dsnHint = parsed.dsn.replace(/^https?:\/\//, "").split("/")[0] ?? null;
        } catch {
          // legacy plain-key row
        }
      }
      return {
        provider: meta.id,
        name: meta.name,
        description: meta.description,
        docsUrl: meta.docsUrl,
        category: meta.category,
        connected: Boolean(row),
        keyHint: row?.keyHint ?? null,
        status: row?.status ?? null,
        lastValidatedAt: row?.lastValidatedAt?.toISOString() ?? null,
        creditDiscount:
          meta.category === "messaging"
            ? "Powers LinkedIn & WhatsApp sends in sequences and Deliverability"
            : meta.category === "gtm_import"
              ? "Browse and import your Apollo sequences from Settings → Integrations once connected"
              : "25% off Skout credits when your key is used",
        dsnHint,
      };
    });

    return { workspaceId, data };
  }

  async save(
    workspaceId: string,
    provider: string,
    apiKey: string,
    extras?: { dsn?: string }
  ): Promise<IntegrationDto> {
    if (!isIntegrationProviderId(provider)) {
      throw new HttpError("invalid_provider", 400);
    }
    const trimmed = apiKey.trim();
    if (trimmed.length < 8) {
      throw new HttpError("api_key_too_short", 400);
    }

    const dsn =
      provider === "unipile"
        ? normalizeUnipileDsn(extras?.dsn?.trim() || this.config.UNIPILE_DSN || DEFAULT_UNIPILE_DSN)
        : undefined;

    await this.validateProviderKey(provider, trimmed, dsn);

    if (!this.db) {
      throw new HttpError("database_unavailable", 503);
    }

    const secretPayload =
      provider === "unipile" ? JSON.stringify({ apiKey: trimmed, dsn }) : trimmed;
    const encrypted = encryptSecret(secretPayload, this.encryptionSecret);
    const hint = maskApiKey(trimmed);
    const now = new Date();

    await this.db
      .insert(workspaceIntegrations)
      .values({
        workspaceId,
        provider,
        encryptedApiKey: encrypted,
        keyHint: hint,
        status: "active",
        lastValidatedAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [workspaceIntegrations.workspaceId, workspaceIntegrations.provider],
        set: {
          encryptedApiKey: encrypted,
          keyHint: hint,
          status: "active",
          lastValidatedAt: now,
          updatedAt: now,
        },
      });

    const listed = await this.list(workspaceId);
    const dto = listed.data.find((d) => d.provider === provider);
    if (!dto) throw new HttpError("integration_save_failed", 500);
    log.info("integration saved", { workspaceId, provider });
    return dto;
  }

  async remove(workspaceId: string, provider: string): Promise<void> {
    if (!isIntegrationProviderId(provider)) {
      throw new HttpError("invalid_provider", 400);
    }
    if (!this.db) throw new HttpError("database_unavailable", 503);
    await this.db
      .delete(workspaceIntegrations)
      .where(
        and(
          eq(workspaceIntegrations.workspaceId, workspaceId),
          eq(workspaceIntegrations.provider, provider)
        )
      );
    log.info("integration removed", { workspaceId, provider });
  }

  async test(
    workspaceId: string,
    provider: string,
    apiKey?: string,
    extras?: { dsn?: string }
  ): Promise<{ ok: true }> {
    if (!isIntegrationProviderId(provider)) {
      throw new HttpError("invalid_provider", 400);
    }

    let key = apiKey?.trim();
    let dsn = extras?.dsn?.trim();
    if (!key) {
      if (provider === "unipile") {
        const creds = await this.loadWorkspaceUnipileCredentials(workspaceId);
        if (!creds) throw new HttpError("integration_not_configured", 404);
        key = creds.apiKey;
        dsn = dsn || creds.dsn;
      } else {
        const stored = await this.getDecryptedKey(workspaceId, provider);
        if (!stored) throw new HttpError("integration_not_configured", 404);
        key = stored;
      }
    }

    await this.validateProviderKey(
      provider,
      key,
      provider === "unipile"
        ? normalizeUnipileDsn(dsn || this.config.UNIPILE_DSN || DEFAULT_UNIPILE_DSN)
        : undefined
    );

    if (this.db && !apiKey) {
      await this.db
        .update(workspaceIntegrations)
        .set({ lastValidatedAt: new Date(), status: "active", updatedAt: new Date() })
        .where(
          and(
            eq(workspaceIntegrations.workspaceId, workspaceId),
            eq(workspaceIntegrations.provider, provider)
          )
        );
    }

    log.info("integration key validated", { workspaceId, provider });
    return { ok: true };
  }

  async loadWorkspacePalConfig(workspaceId: string) {
    if (!this.db) return {};
    const rows = await this.db
      .select()
      .from(workspaceIntegrations)
      .where(eq(workspaceIntegrations.workspaceId, workspaceId));

    const keys: Partial<Record<IntegrationProviderId, string>> = {};
    for (const row of rows) {
      if (!isIntegrationProviderId(row.provider)) continue;
      if (row.provider === "unipile") continue;
      try {
        keys[row.provider] = this.decryptStored(row.encryptedApiKey);
      } catch {
        // Corrupt row — skip; user can re-save.
      }
    }
    return palConfigFromIntegrations(keys);
  }

  /** Workspace Unipile BYOK (falls back to null — caller uses platform env). */
  async loadWorkspaceUnipileCredentials(
    workspaceId: string
  ): Promise<{ apiKey: string; dsn: string } | null> {
    if (!this.db) return null;
    const [row] = await this.db
      .select()
      .from(workspaceIntegrations)
      .where(
        and(
          eq(workspaceIntegrations.workspaceId, workspaceId),
          eq(workspaceIntegrations.provider, "unipile")
        )
      )
      .limit(1);
    if (!row) return null;
    try {
      const raw = this.decryptStored(row.encryptedApiKey);
      try {
        const parsed = JSON.parse(raw) as { apiKey?: string; dsn?: string };
        if (parsed?.apiKey?.trim()) {
          return {
            apiKey: parsed.apiKey.trim(),
            dsn: normalizeUnipileDsn(parsed.dsn || this.config.UNIPILE_DSN || DEFAULT_UNIPILE_DSN),
          };
        }
      } catch {
        // legacy plain API key
        if (raw.trim().length >= 8) {
          return {
            apiKey: raw.trim(),
            dsn: normalizeUnipileDsn(this.config.UNIPILE_DSN || DEFAULT_UNIPILE_DSN),
          };
        }
      }
    } catch {
      return null;
    }
    return null;
  }

  /** Public wrapper for routes that need the raw decrypted key (e.g. R22.3 Apollo import). */
  async getDecryptedProviderKey(workspaceId: string, provider: IntegrationProviderId): Promise<string | null> {
    return this.getDecryptedKey(workspaceId, provider);
  }

  private async getDecryptedKey(
    workspaceId: string,
    provider: IntegrationProviderId
  ): Promise<string | null> {
    if (!this.db) return null;
    const [row] = await this.db
      .select()
      .from(workspaceIntegrations)
      .where(
        and(
          eq(workspaceIntegrations.workspaceId, workspaceId),
          eq(workspaceIntegrations.provider, provider)
        )
      )
      .limit(1);
    if (!row) return null;
    return this.decryptStored(row.encryptedApiKey);
  }

  private async validateProviderKey(
    provider: IntegrationProviderId,
    apiKey: string,
    dsn?: string
  ): Promise<void> {
    const timeoutMs = this.config.ENRICHMENT_REQUEST_TIMEOUT_MS;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const ok = await this.pingProvider(provider, apiKey, controller.signal, dsn);
      if (!ok) throw new HttpError("invalid_api_key", 400, { provider });
    } catch (err) {
      if (err instanceof HttpError) throw err;
      if (err instanceof Error && err.name === "AbortError") {
        throw new HttpError("provider_timeout", 504, { provider });
      }
      throw new HttpError("provider_validation_failed", 400, {
        provider,
        detail: err instanceof Error ? err.message : String(err),
      });
    } finally {
      clearTimeout(timer);
    }
  }

  private async pingProvider(
    provider: IntegrationProviderId,
    apiKey: string,
    signal: AbortSignal,
    dsn?: string
  ): Promise<boolean> {
    const qs = new URLSearchParams({ api_key: apiKey });

    switch (provider) {
      case "hunter": {
        const res = await fetch(`https://api.hunter.io/v2/account?${qs}`, { signal });
        if (res.status === 401) return false;
        return res.ok;
      }
      case "zerobounce": {
        const res = await fetch(`https://api.zerobounce.net/v2/getcredits?${qs}`, { signal });
        if (res.status === 401) return false;
        return res.ok;
      }
      case "millionverifier": {
        const res = await fetch(
          `https://api.millionverifier.com/api/v3/credits?api=${encodeURIComponent(apiKey)}`,
          { signal }
        );
        if (res.status === 401) return false;
        return res.ok;
      }
      case "neverbounce": {
        const res = await fetch("https://api.neverbounce.com/v4/account/info", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ key: apiKey }),
          signal,
        });
        if (res.status === 401) return false;
        return res.ok;
      }
      case "pdl": {
        const res = await fetch(
          "https://api.peopledatalabs.com/v5/company/enrich?website=peopledatalabs.com",
          {
            headers: { "X-Api-Key": apiKey },
            signal,
          }
        );
        if (res.status === 401 || res.status === 403) return false;
        return res.ok || res.status === 404;
      }
      case "datagma": {
        const res = await fetch(
          `https://gateway.datagma.net/api/ingress/v2/full?apiId=${encodeURIComponent(apiKey)}&data=ping`,
          { signal }
        );
        if (res.status === 401 || res.status === 403) return false;
        return res.status < 500;
      }
      case "contactout": {
        const res = await fetch("https://api.contactout.com/v1/stats", {
          headers: { token: apiKey, Accept: "application/json" },
          signal,
        });
        if (res.status === 401 || res.status === 403) return false;
        return res.ok;
      }
      case "unipile": {
        const base = normalizeUnipileDsn(dsn || this.config.UNIPILE_DSN || DEFAULT_UNIPILE_DSN);
        const res = await fetch(`${base}/api/v1/accounts`, {
          headers: { "X-API-KEY": apiKey, accept: "application/json" },
          signal,
        });
        if (res.status === 401 || res.status === 403) return false;
        return res.ok;
      }
      case "apollo": {
        // Apollo's v1 API takes the key in the JSON body, not a header.
        const res = await fetch("https://api.apollo.io/v1/auth/health", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ api_key: apiKey }),
          signal,
        });
        if (res.status === 401 || res.status === 403) return false;
        if (!res.ok) return false;
        const json = (await res.json().catch(() => ({}))) as { is_logged_in?: boolean };
        return json.is_logged_in !== false;
      }
      default:
        return apiKey.length >= 8;
    }
  }
}

export function workspaceEngineCacheKey(
  platformCfg: unknown,
  workspaceCfg: unknown,
  phoneGate: number
): string {
  return createHash("sha256")
    .update(JSON.stringify({ platformCfg, workspaceCfg, phoneGate }))
    .digest("hex");
}

export function createIntegrationService(db: Db | null, config: Env): IntegrationService {
  return new IntegrationService(db, config);
}
