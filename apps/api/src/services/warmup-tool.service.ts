import { eq } from "drizzle-orm";
import type { Db } from "@skout/db";
import { schema, scopedTo } from "@skout/db";
import { createLogger } from "@skout/observability";
import { decryptSecretWithFallback, encryptSecret, maskApiKey } from "@skout/shared";
import type { Env } from "../config/env.js";

const log = createLogger("warmup-tool.service");
const { workspaceIntegrations, warmupToolSyncState } = schema;

export const WARMUP_TOOL_PROVIDER = "warmup-tool";

export class WarmupToolUnavailableError extends Error {
  readonly upstreamStatus?: number;
  readonly upstreamBody?: unknown;

  constructor(message: string, upstreamStatus?: number, upstreamBody?: unknown) {
    super(message);
    this.name = "WarmupToolUnavailableError";
    this.upstreamStatus = upstreamStatus;
    this.upstreamBody = upstreamBody;
  }
}

export function isWarmupToolConfigured(config: Pick<Env, "WARMUP_TOOL_SERVICE_URL">): boolean {
  return Boolean(config.WARMUP_TOOL_SERVICE_URL?.trim());
}

function baseUrl(config: Pick<Env, "WARMUP_TOOL_SERVICE_URL">): string | null {
  const url = config.WARMUP_TOOL_SERVICE_URL?.trim();
  return url ? url.replace(/\/$/, "") : null;
}

function encryptionSecret(config: Env): string {
  return (
    config.INTEGRATION_ENCRYPTION_KEY ??
    config.CLERK_SECRET_KEY ??
    "dev-integration-encryption-key-change-me"
  );
}

function decryptIntegrationSecret(payload: string, config: Env): string {
  return decryptSecretWithFallback(
    payload,
    encryptionSecret(config),
    config.INTEGRATION_ENCRYPTION_KEY_PREVIOUS
  );
}

type UpstreamInit = {
  method?: string;
  headers?: Record<string, string>;
  body?: string | Buffer | null;
  query?: string;
  timeoutMs?: number;
  /** When set, use this Bearer instead of the workspace key (platform provisioning). */
  bearerOverride?: string;
};

async function upstreamFetch(
  config: Env,
  path: string,
  init: UpstreamInit = {}
): Promise<{ status: number; headers: Headers; bodyText: string }> {
  const root = baseUrl(config);
  if (!root) {
    throw new WarmupToolUnavailableError("WARMUP_TOOL_SERVICE_URL is not configured");
  }

  const query = init.query?.startsWith("?") ? init.query : init.query ? `?${init.query}` : "";
  const url = `${root}${path.startsWith("/") ? path : `/${path}`}${query}`;
  const timeoutMs = init.timeoutMs ?? config.WARMUP_TOOL_TIMEOUT_MS;

  let res: Response;
  try {
    const bodyInit: BodyInit | undefined =
      init.body == null
        ? undefined
        : typeof init.body === "string"
          ? init.body
          : new Uint8Array(init.body);
    res = await fetch(url, {
      method: init.method ?? "GET",
      headers: init.headers,
      body: bodyInit,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    throw new WarmupToolUnavailableError(err instanceof Error ? err.message : String(err));
  }

  const bodyText = await res.text();
  return { status: res.status, headers: res.headers, bodyText };
}

function parseJsonSafe(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

/**
 * Resolve (or auto-provision) the Warm-Up Tool API key for a Skout workspace.
 * Keys are stored encrypted in workspace_integrations (provider=warmup-tool).
 */
export async function resolveWorkspaceWarmupApiKey(
  db: Db,
  config: Env,
  workspaceId: string,
  workspaceName?: string
): Promise<string> {
  const existing = await db
    .select()
    .from(workspaceIntegrations)
    .where(
      scopedTo(workspaceIntegrations, workspaceId, eq(workspaceIntegrations.provider, WARMUP_TOOL_PROVIDER))
    )
    .limit(1);

  const row = existing[0];
  if (row?.encryptedApiKey && row.status === "active") {
    return decryptIntegrationSecret(row.encryptedApiKey, config);
  }

  const provisionKey = config.WARMUP_TOOL_PLATFORM_PROVISIONING_KEY?.trim();
  if (!provisionKey) {
    throw new WarmupToolUnavailableError(
      "WARMUP_TOOL_PLATFORM_PROVISIONING_KEY is not configured; cannot provision workspace tenant"
    );
  }

  const { status, bodyText } = await upstreamFetch(config, "/api/v1/internal/provision-tenant", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${provisionKey}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      tenantName: workspaceName?.trim() || `Skout workspace ${workspaceId}`,
      credentialName: `skout-workspace-${workspaceId}`,
      externalRef: workspaceId,
    }),
  });

  if (status < 200 || status >= 300) {
    throw new WarmupToolUnavailableError(
      `provision-tenant failed: upstream ${status}`,
      status,
      parseJsonSafe(bodyText)
    );
  }

  const payload = parseJsonSafe(bodyText) as {
    apiKey?: string;
    tenant?: { id?: string };
    credential?: { prefix?: string };
  };
  const apiKey = payload.apiKey?.trim();
  if (!apiKey) {
    throw new WarmupToolUnavailableError("provision-tenant returned no apiKey", status, payload);
  }

  const encrypted = encryptSecret(apiKey, encryptionSecret(config));
  const hint = payload.credential?.prefix
    ? `${payload.credential.prefix}…`
    : maskApiKey(apiKey);

  await db
    .insert(workspaceIntegrations)
    .values({
      workspaceId,
      provider: WARMUP_TOOL_PROVIDER,
      encryptedApiKey: encrypted,
      keyHint: hint,
      status: "active",
      lastValidatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: [workspaceIntegrations.workspaceId, workspaceIntegrations.provider],
      set: {
        encryptedApiKey: encrypted,
        keyHint: hint,
        status: "active",
        lastValidatedAt: new Date(),
        updatedAt: new Date(),
      },
    });

  log.info("Provisioned Warm-Up Tool tenant for workspace", {
    workspaceId,
    tenantId: payload.tenant?.id,
  });

  return apiKey;
}

export type ProxyResult = {
  status: number;
  contentType: string | null;
  body: string;
};

/**
 * Forward a request to the Warm-Up Tool with the workspace Bearer key.
 * Strips plaintext `apiKey` from credential-issue responses before returning to the browser.
 */
export async function proxyWarmupTool(
  db: Db,
  config: Env,
  workspaceId: string,
  opts: {
    upstreamPath: string;
    method: string;
    query?: string;
    body?: string | Buffer | null;
    contentType?: string | null;
    workspaceName?: string;
  }
): Promise<ProxyResult> {
  const apiKey = await resolveWorkspaceWarmupApiKey(db, config, workspaceId, opts.workspaceName);

  const headers: Record<string, string> = {
    Authorization: `Bearer ${apiKey}`,
    Accept: "application/json",
  };
  if (opts.body != null && opts.contentType) {
    headers["Content-Type"] = opts.contentType;
  } else if (opts.body != null) {
    headers["Content-Type"] = "application/json";
  }

  const { status, headers: resHeaders, bodyText } = await upstreamFetch(config, opts.upstreamPath, {
    method: opts.method,
    headers,
    body: opts.body,
    query: opts.query,
  });

  let body = bodyText;
  // Never leak freshly issued swu_ keys to the browser.
  if (
    opts.upstreamPath.startsWith("/api/v1/credentials") &&
    (opts.method === "POST" || opts.upstreamPath.includes("/rotate"))
  ) {
    try {
      const json = JSON.parse(bodyText) as Record<string, unknown>;
      if ("apiKey" in json) {
        delete json.apiKey;
        json.warning =
          "API key was issued server-side and stored encrypted for this workspace; it is not returned to the browser.";
        body = JSON.stringify(json);
      }
    } catch {
      /* leave body as-is */
    }
  }

  return {
    status,
    contentType: resHeaders.get("content-type"),
    body,
  };
}

/** Public OAuth callback forward (no workspace key — upstream validates OAuth state). */
export async function proxyWarmupOAuthCallback(
  config: Env,
  provider: "google" | "microsoft",
  query: string
): Promise<ProxyResult> {
  const path = `/api/v1/oauth/${provider}/callback`;
  const { status, headers, bodyText } = await upstreamFetch(config, path, {
    method: "GET",
    query,
    headers: { Accept: "text/html,application/json" },
  });
  return {
    status,
    contentType: headers.get("content-type"),
    body: bodyText,
  };
}

/** Poll integration-events and advance the workspace cursor. */
export async function pollIntegrationEvents(
  db: Db,
  config: Env,
  workspaceId: string,
  opts: { limit?: number; workspaceName?: string } = {}
): Promise<{ events: unknown[]; nextCursor: string | null; polled: number }> {
  const apiKey = await resolveWorkspaceWarmupApiKey(db, config, workspaceId, opts.workspaceName);

  const [state] = await db
    .select()
    .from(warmupToolSyncState)
    .where(scopedTo(warmupToolSyncState, workspaceId))
    .limit(1);

  const cursor = state?.lastEventId ?? null;

  const params = new URLSearchParams();
  params.set("limit", String(opts.limit ?? 50));
  if (cursor) params.set("cursor", cursor);

  const { status, bodyText } = await upstreamFetch(config, "/api/v1/integration-events", {
    method: "GET",
    query: params.toString(),
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: "application/json",
    },
  });

  if (status < 200 || status >= 300) {
    throw new WarmupToolUnavailableError(`integration-events ${status}`, status, parseJsonSafe(bodyText));
  }

  const payload = parseJsonSafe(bodyText) as {
    events?: Array<{ eventId?: string }>;
    nextCursor?: string | null;
    data?: Array<{ eventId?: string }>;
  };
  const events = payload.events ?? payload.data ?? [];
  const nextCursor =
    payload.nextCursor ??
    (events.length > 0 ? (events[events.length - 1]?.eventId ?? cursor) : cursor);

  if (nextCursor) {
    await db
      .insert(warmupToolSyncState)
      .values({
        workspaceId,
        lastEventId: nextCursor,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [warmupToolSyncState.workspaceId],
        set: { lastEventId: nextCursor, updatedAt: new Date() },
      });
  }

  return { events, nextCursor: nextCursor ?? null, polled: events.length };
}

/**
 * Fail-open: list Warm-Up Tool mailboxes and return a map keyed by lowercase email.
 */
export async function listWarmupMailboxesByEmail(
  db: Db,
  config: Env,
  workspaceId: string
): Promise<Map<string, { id: string; status?: string; enabled?: boolean }>> {
  const map = new Map<string, { id: string; status?: string; enabled?: boolean }>();
  if (!isWarmupToolConfigured(config)) return map;
  try {
    const apiKey = await resolveWorkspaceWarmupApiKey(db, config, workspaceId);
    const { status, bodyText } = await upstreamFetch(config, "/api/v1/mailboxes", {
      method: "GET",
      headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
      timeoutMs: Math.min(config.WARMUP_TOOL_TIMEOUT_MS, 8000),
    });
    if (status < 200 || status >= 300) return map;
    const payload = parseJsonSafe(bodyText) as {
      mailboxes?: Array<{ id: string; email?: string; address?: string; status?: string; enabled?: boolean }>;
      data?: Array<{ id: string; email?: string; address?: string; status?: string; enabled?: boolean }>;
    };
    const list = payload.mailboxes ?? payload.data ?? [];
    for (const m of list) {
      const email = (
        (m as { emailAddress?: string }).emailAddress ??
        m.email ??
        m.address
      )
        ?.trim()
        .toLowerCase();
      if (email) map.set(email, { id: m.id, status: m.status, enabled: m.enabled });
    }
  } catch (err) {
    log.warn("Warm-up mailbox index failed (fail-open)", {
      workspaceId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
  return map;
}
