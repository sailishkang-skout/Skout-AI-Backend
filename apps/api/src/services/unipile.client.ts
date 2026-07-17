import type { Env } from "../config/env.js";

export class UnipileError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body?: unknown
  ) {
    super(message);
    this.name = "UnipileError";
  }
}

export interface UnipileProfile {
  provider_id: string;
  public_identifier?: string;
  first_name?: string;
  last_name?: string;
}

function requireUnipile(config: Env): { dsn: string; apiKey: string } {
  const dsn = config.UNIPILE_DSN?.replace(/\/$/, "");
  const apiKey = config.UNIPILE_API_KEY;
  if (!dsn || !apiKey) {
    throw new UnipileError("unipile_not_configured", 503);
  }
  return { dsn, apiKey };
}

async function unipileFetch<T>(
  config: Env,
  path: string,
  init?: RequestInit & { form?: Record<string, string | string[]> }
): Promise<T> {
  const { dsn, apiKey } = requireUnipile(config);
  const headers = new Headers(init?.headers);
  headers.set("X-API-KEY", apiKey);
  headers.set("accept", "application/json");

  let body = init?.body;
  if (init?.form) {
    const form = new FormData();
    for (const [key, value] of Object.entries(init.form)) {
      if (Array.isArray(value)) {
        for (const v of value) form.append(key, v);
      } else {
        form.append(key, value);
      }
    }
    body = form;
  } else if (body && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }

  const res = await fetch(`${dsn}${path}`, { ...init, headers, body });
  const text = await res.text();
  let parsed: unknown = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
  }
  if (!res.ok) {
    const msg =
      typeof parsed === "object" && parsed && "message" in parsed
        ? String((parsed as { message: unknown }).message)
        : `unipile_http_${res.status}`;
    throw new UnipileError(msg, res.status, parsed);
  }
  return parsed as T;
}

/** Resolve LinkedIn public slug (from URL) to Unipile provider_id. */
export async function unipileGetProfileBySlug(
  config: Env,
  accountId: string,
  publicIdentifier: string
): Promise<UnipileProfile> {
  const data = await unipileFetch<UnipileProfile>(
    config,
    `/api/v1/users/${encodeURIComponent(publicIdentifier)}?account_id=${encodeURIComponent(accountId)}`
  );
  if (!data?.provider_id) {
    throw new UnipileError("linkedin_provider_id_missing", 502, data);
  }
  return data;
}

export async function unipileSendInvitation(
  config: Env,
  input: { accountId: string; providerId: string; message?: string | null }
): Promise<unknown> {
  return unipileFetch(config, "/api/v1/users/invite", {
    method: "POST",
    body: JSON.stringify({
      account_id: input.accountId,
      provider_id: input.providerId,
      ...(input.message ? { message: input.message.slice(0, 300) } : {}),
    }),
  });
}

export async function unipileStartChat(
  config: Env,
  input: { accountId: string; providerId: string; text: string }
): Promise<unknown> {
  return unipileFetch(config, "/api/v1/chats", {
    method: "POST",
    form: {
      account_id: input.accountId,
      attendees_ids: input.providerId,
      text: input.text.slice(0, 8000),
    },
  });
}

/** Hosted auth link so the user can connect LinkedIn without the Chrome extension. */
export async function unipileCreateHostedAuthLink(
  config: Env,
  input: { successRedirectUrl: string; failureRedirectUrl: string; notifyUrl?: string }
): Promise<{ url: string }> {
  const data = await unipileFetch<{ url?: string; object?: string }>(config, "/api/v1/hosted/accounts/link", {
    method: "POST",
    body: JSON.stringify({
      type: "create",
      providers: ["LINKEDIN"],
      api_url: config.UNIPILE_DSN?.replace(/\/$/, ""),
      expiresOn: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      success_redirect_url: input.successRedirectUrl,
      failure_redirect_url: input.failureRedirectUrl,
      ...(input.notifyUrl ? { notify_url: input.notifyUrl } : {}),
    }),
  });
  if (!data?.url) throw new UnipileError("hosted_auth_url_missing", 502, data);
  return { url: data.url };
}

export function linkedinPublicIdentifierFromUrl(url: string): string | null {
  try {
    const u = new URL(url);
    if (!u.hostname.includes("linkedin.com")) return null;
    const parts = u.pathname.split("/").filter(Boolean);
    const idx = parts.indexOf("in");
    if (idx >= 0 && parts[idx + 1]) {
      return decodeURIComponent(parts[idx + 1]!).replace(/\/$/, "");
    }
    return null;
  } catch {
    return null;
  }
}

export function isUnipileConfigured(config: Env): boolean {
  return Boolean(config.UNIPILE_API_KEY && config.UNIPILE_DSN);
}
