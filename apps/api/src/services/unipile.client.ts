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

export type UnipileProvider = "LINKEDIN" | "WHATSAPP";

export interface UnipileProfile {
  provider_id: string;
  public_identifier?: string;
  first_name?: string;
  last_name?: string;
}

export interface UnipileAccount {
  id: string;
  name?: string;
  /** Present on some payloads; prefer `type` from list accounts. */
  provider?: string;
  /** e.g. LINKEDIN, WHATSAPP */
  type?: string;
  connection_status?: string;
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

/** List connected Unipile accounts (LinkedIn, WhatsApp, …). */
export async function unipileListAccounts(config: Env): Promise<UnipileAccount[]> {
  const data = await unipileFetch<{ items?: UnipileAccount[] } | UnipileAccount[]>(
    config,
    "/api/v1/accounts"
  );
  if (Array.isArray(data)) return data;
  return data?.items ?? [];
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

/**
 * Start / continue a WhatsApp chat.
 * `attendeeId` is typically the E.164 phone (digits) or Unipile WhatsApp provider id.
 */
export async function unipileSendWhatsapp(
  config: Env,
  input: { accountId: string; attendeeId: string; text: string }
): Promise<unknown> {
  return unipileFetch(config, "/api/v1/chats", {
    method: "POST",
    form: {
      account_id: input.accountId,
      attendees_ids: input.attendeeId,
      text: input.text.slice(0, 8000),
    },
  });
}

export interface UnipileChat {
  id: string;
  account_id?: string;
  name?: string | null;
  /** 0 = direct, 1 = group (WhatsApp) */
  type?: number;
  timestamp?: string;
  unread_count?: number;
  unread?: number;
  account_type?: string;
  attendee_provider_id?: string;
  /** WhatsApp JID e.g. 9198…@s.whatsapp.net or …@g.us */
  provider_id?: string;
  attendee_public_identifier?: string;
  content_type?: string;
  lastMessage?: {
    text?: string | null;
    body?: string | null;
    timestamp?: string;
    is_sender?: number | boolean;
  } | null;
}

export interface UnipileChatAttendee {
  id: string;
  name?: string | null;
  is_self?: number | boolean;
  provider_id?: string;
  picture_url?: string | null;
}

export interface UnipileChatMessage {
  id: string;
  chat_id?: string;
  text?: string | null;
  body?: string | null;
  is_sender?: number | boolean;
  sender_id?: string;
  sender_name?: string | null;
  timestamp?: string;
  date?: string;
  sent_at?: string;
  /** Present on some WhatsApp payloads */
  pushName?: string | null;
  original?: string | null;
}

export async function unipileListChats(
  config: Env,
  input: { accountId: string; limit?: number; cursor?: string }
): Promise<{ items: UnipileChat[]; cursor: string | null }> {
  const qs = new URLSearchParams({
    account_id: input.accountId,
    limit: String(input.limit ?? 50),
  });
  if (input.cursor) qs.set("cursor", input.cursor);
  const data = await unipileFetch<{ items?: UnipileChat[]; cursor?: string | null } | UnipileChat[]>(
    config,
    `/api/v1/chats?${qs}`
  );
  if (Array.isArray(data)) return { items: data, cursor: null };
  return { items: data?.items ?? [], cursor: data?.cursor ?? null };
}

export async function unipileListChatAttendees(
  config: Env,
  chatId: string
): Promise<UnipileChatAttendee[]> {
  const data = await unipileFetch<{ items?: UnipileChatAttendee[] } | UnipileChatAttendee[]>(
    config,
    `/api/v1/chats/${encodeURIComponent(chatId)}/attendees`
  );
  if (Array.isArray(data)) return data;
  return data?.items ?? [];
}

export async function unipileListChatMessages(
  config: Env,
  input: { chatId: string; limit?: number; cursor?: string }
): Promise<{ items: UnipileChatMessage[]; cursor: string | null }> {
  const qs = new URLSearchParams({ limit: String(input.limit ?? 50) });
  if (input.cursor) qs.set("cursor", input.cursor);
  const data = await unipileFetch<
    { items?: UnipileChatMessage[]; cursor?: string | null } | UnipileChatMessage[]
  >(config, `/api/v1/chats/${encodeURIComponent(input.chatId)}/messages?${qs}`);
  if (Array.isArray(data)) return { items: data, cursor: null };
  return { items: data?.items ?? [], cursor: data?.cursor ?? null };
}

/** Reply in an existing Unipile chat (LinkedIn / WhatsApp / …). */
export async function unipileSendChatMessage(
  config: Env,
  input: { chatId: string; accountId?: string; text: string }
): Promise<unknown> {
  return unipileFetch(config, `/api/v1/chats/${encodeURIComponent(input.chatId)}/messages`, {
    method: "POST",
    form: {
      text: input.text.slice(0, 8000),
      ...(input.accountId ? { account_id: input.accountId } : {}),
    },
  });
}

/** Mark a chat as read (LinkedIn & WhatsApp). */
export async function unipileMarkChatRead(config: Env, chatId: string): Promise<unknown> {
  return unipileFetch(config, `/api/v1/chats/${encodeURIComponent(chatId)}`, {
    method: "PATCH",
    body: JSON.stringify({ action: "setReadStatus", value: true }),
  });
}

/** Hosted auth link so the user can connect LinkedIn / WhatsApp without the Chrome extension. */
export async function unipileCreateHostedAuthLink(
  config: Env,
  input: {
    successRedirectUrl: string;
    failureRedirectUrl: string;
    notifyUrl?: string;
    providers?: UnipileProvider[];
  }
): Promise<{ url: string }> {
  const data = await unipileFetch<{ url?: string; object?: string }>(config, "/api/v1/hosted/accounts/link", {
    method: "POST",
    body: JSON.stringify({
      type: "create",
      providers: input.providers?.length ? input.providers : ["LINKEDIN"],
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

export interface UnipileRelation {
  member_id?: string;
  first_name?: string;
  last_name?: string;
  headline?: string | null;
  public_identifier?: string | null;
  public_profile_url?: string | null;
  profile_picture_url?: string | null;
}

export interface UnipilePeopleSearchItem {
  type?: string;
  id: string;
  name?: string | null;
  headline?: string | null;
  location?: string | null;
  network_distance?: string | null;
  public_identifier?: string | null;
  profile_url?: string | null;
  public_profile_url?: string | null;
  profile_picture_url?: string | null;
}

/** List / filter first-degree LinkedIn connections. */
export async function unipileListRelations(
  config: Env,
  input: { accountId: string; limit?: number; filter?: string; cursor?: string }
): Promise<{ items: UnipileRelation[]; cursor: string | null }> {
  const qs = new URLSearchParams({
    account_id: input.accountId,
    limit: String(input.limit ?? 25),
  });
  if (input.filter?.trim()) qs.set("filter", input.filter.trim());
  if (input.cursor) qs.set("cursor", input.cursor);
  const data = await unipileFetch<{ items?: UnipileRelation[]; cursor?: string | null }>(
    config,
    `/api/v1/users/relations?${qs}`
  );
  return { items: data?.items ?? [], cursor: data?.cursor ?? null };
}

/** Classic LinkedIn people search (2nd/3rd degree + keywords). */
export async function unipileSearchPeople(
  config: Env,
  input: { accountId: string; keywords: string; limit?: number; cursor?: string }
): Promise<{ items: UnipilePeopleSearchItem[]; cursor: string | null }> {
  const qs = new URLSearchParams({
    account_id: input.accountId,
    limit: String(Math.min(input.limit ?? 25, 50)),
  });
  if (input.cursor) qs.set("cursor", input.cursor);
  const data = await unipileFetch<{ items?: UnipilePeopleSearchItem[]; cursor?: string | null }>(
    config,
    `/api/v1/linkedin/search?${qs}`,
    {
      method: "POST",
      body: JSON.stringify({
        api: "classic",
        category: "people",
        keywords: input.keywords.trim(),
      }),
    }
  );
  return { items: data?.items ?? [], cursor: data?.cursor ?? null };
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

/** Normalize phone to digits suitable for Unipile WhatsApp attendees. */
export function normalizeWhatsappAttendeeId(phone: string): string | null {
  const digits = phone.replace(/\D/g, "");
  if (digits.length < 8 || digits.length > 15) return null;
  return digits;
}

export function isUnipileConfigured(config: Env): boolean {
  const key = config.UNIPILE_API_KEY?.trim();
  const dsn = config.UNIPILE_DSN?.trim();
  // CDK seeds Secrets Manager with "replace-me" — treat that as unset.
  return Boolean(key && dsn && key !== "replace-me");
}
