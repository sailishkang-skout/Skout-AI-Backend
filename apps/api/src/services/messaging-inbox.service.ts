import { eq } from "drizzle-orm";
import type { Db } from "@skout/db";
import { schema, scopedTo } from "@skout/db";
import type { Env } from "../config/env.js";
import { HttpError } from "../utils/http.js";
import { createIntegrationService } from "./integration.service.js";
import { DEFAULT_UNIPILE_DSN } from "./integration-providers.js";
import {
  isUnipileConfigured,
  normalizeWhatsappAttendeeId,
  unipileListChatAttendees,
  unipileListChatMessages,
  unipileListChats,
  unipileListRelations,
  unipileMarkChatRead,
  unipileSearchPeople,
  unipileSendChatMessage,
  unipileSendInvitation,
  unipileSendWhatsapp,
  unipileStartChat,
  UnipileError,
  type UnipileChat,
  type UnipileChatAttendee,
  type UnipileChatMessage,
  type UnipilePeopleSearchItem,
  type UnipileRelation,
} from "./unipile.client.js";

const { linkedinAccounts } = schema;

export type MessagingChannel = "linkedin" | "whatsapp";

export type MessagingThreadId = {
  channel: MessagingChannel;
  unipileAccountId: string;
  chatId: string;
};

const PREFIX: Record<MessagingChannel, string> = {
  linkedin: "li:",
  whatsapp: "wa:",
};

export function encodeMessagingThreadId(
  channel: MessagingChannel,
  unipileAccountId: string,
  chatId: string
): string {
  return `${PREFIX[channel]}${unipileAccountId}:${chatId}`;
}

export function parseMessagingThreadId(threadId: string): MessagingThreadId | null {
  let channel: MessagingChannel | null = null;
  let rest = threadId;
  if (threadId.startsWith("li:")) {
    channel = "linkedin";
    rest = threadId.slice(3);
  } else if (threadId.startsWith("wa:")) {
    channel = "whatsapp";
    rest = threadId.slice(3);
  }
  if (!channel) return null;
  const idx = rest.indexOf(":");
  if (idx <= 0) return null;
  const unipileAccountId = rest.slice(0, idx);
  const chatId = rest.slice(idx + 1);
  if (!unipileAccountId || !chatId) return null;
  return { channel, unipileAccountId, chatId };
}

function isTruthyFlag(v: number | boolean | undefined): boolean {
  return v === true || v === 1;
}

function messageText(m: UnipileChatMessage): string {
  const direct = (m.text ?? m.body ?? "").trim();
  if (direct) return direct;
  if (m.original) {
    try {
      const parsed = JSON.parse(m.original) as { message?: Record<string, unknown> };
      const msg = parsed.message ?? {};
      if (typeof msg.conversation === "string" && msg.conversation.trim()) {
        return msg.conversation.trim();
      }
      if (msg.imageMessage) return "[Image]";
      if (msg.videoMessage) return "[Video]";
      if (msg.audioMessage) return "[Audio]";
      if (msg.documentMessage) return "[Document]";
      if (msg.stickerMessage) return "[Sticker]";
      if (msg.extendedTextMessage && typeof (msg.extendedTextMessage as { text?: string }).text === "string") {
        return ((msg.extendedTextMessage as { text: string }).text || "").trim();
      }
    } catch {
      // ignore
    }
  }
  return "";
}

function messageSentAt(m: UnipileChatMessage): string {
  return m.timestamp ?? m.date ?? m.sent_at ?? new Date().toISOString();
}

function channelLabel(channel: MessagingChannel): string {
  return channel === "whatsapp" ? "WhatsApp" : "LinkedIn";
}

/** Resolve a human-readable WhatsApp chat title from name / JID. */
function whatsappChatTitle(chat: UnipileChat): {
  title: string;
  kind: "dm" | "group" | "channel";
  phoneOrJid: string | null;
} {
  const named = chat.name?.trim() || null;
  const jid = (
    chat.provider_id ||
    chat.attendee_public_identifier ||
    chat.attendee_provider_id ||
    ""
  ).trim();

  if (jid.includes("@g.us") || chat.type === 1) {
    return { title: named || "WhatsApp group", kind: "group", phoneOrJid: jid || null };
  }
  if (jid.includes("@newsletter") || jid.includes("@broadcast")) {
    return { title: named || "WhatsApp channel", kind: "channel", phoneOrJid: jid || null };
  }

  const local = jid.includes("@") ? jid.split("@")[0]! : jid;
  if (/^\d{8,15}$/.test(local)) {
    const formatted =
      local.length > 10
        ? `+${local.slice(0, local.length - 10)} ${local.slice(local.length - 10)}`
        : `+${local}`;
    return { title: named || formatted, kind: "dm", phoneOrJid: local };
  }

  return {
    title: named || jid || "WhatsApp chat",
    kind: "dm",
    phoneOrJid: jid || null,
  };
}

function senderDisplayName(m: UnipileChatMessage): string | null {
  if (m.sender_name?.trim()) return m.sender_name.trim();
  if (m.pushName?.trim()) return m.pushName.trim();
  if (m.original) {
    try {
      const parsed = JSON.parse(m.original) as { pushName?: string };
      if (parsed.pushName?.trim()) return parsed.pushName.trim();
    } catch {
      // ignore
    }
  }
  return null;
}

export class MessagingInboxService {
  constructor(
    private readonly db: Db,
    private readonly config: Env
  ) {}

  private async resolveConfig(workspaceId: string): Promise<Env> {
    const integrations = createIntegrationService(this.db, this.config);
    const creds = await integrations.loadWorkspaceUnipileCredentials(workspaceId);
    if (!creds) return this.config;
    return {
      ...this.config,
      UNIPILE_API_KEY: creds.apiKey,
      UNIPILE_DSN: creds.dsn || this.config.UNIPILE_DSN || DEFAULT_UNIPILE_DSN,
    };
  }

  private async requireAccount(
    workspaceId: string,
    channel: MessagingChannel,
    accountRowId?: string
  ) {
    const [row] = await this.db
      .select()
      .from(linkedinAccounts)
      .where(
        scopedTo(
          linkedinAccounts,
          workspaceId,
          eq(linkedinAccounts.channel, channel),
          eq(linkedinAccounts.status, "active"),
          accountRowId ? eq(linkedinAccounts.id, accountRowId) : undefined
        )
      )
      .limit(1);
    if (!row) {
      throw new HttpError(
        accountRowId ? `${channel}_account_not_found` : `no_active_${channel}_account`,
        404
      );
    }
    return row;
  }

  private async requireAccountByUnipileId(
    workspaceId: string,
    channel: MessagingChannel,
    unipileAccountId: string
  ) {
    const [account] = await this.db
      .select()
      .from(linkedinAccounts)
      .where(
        scopedTo(linkedinAccounts, workspaceId, eq(linkedinAccounts.unipileAccountId, unipileAccountId), eq(linkedinAccounts.channel, channel))
      )
      .limit(1);
    if (!account) throw new HttpError(`${channel}_account_not_found`, 404);
    return account;
  }

  async listAccounts(workspaceId: string, channel: MessagingChannel) {
    return this.db
      .select({
        id: linkedinAccounts.id,
        unipileAccountId: linkedinAccounts.unipileAccountId,
        displayName: linkedinAccounts.displayName,
        phone: linkedinAccounts.phone,
        status: linkedinAccounts.status,
        channel: linkedinAccounts.channel,
      })
      .from(linkedinAccounts)
      .where(
        scopedTo(linkedinAccounts, workspaceId, eq(linkedinAccounts.channel, channel))
      );
  }

  async listChats(
    workspaceId: string,
    channel: MessagingChannel,
    accountRowId?: string,
    limit = 50
  ) {
    const cfg = await this.resolveConfig(workspaceId);
    if (!isUnipileConfigured(cfg)) {
      throw new HttpError("Messaging is not configured (UNIPILE_API_KEY / UNIPILE_DSN)", 503);
    }
    const account = await this.requireAccount(workspaceId, channel, accountRowId);
    const { items } = await unipileListChats(cfg, {
      accountId: account.unipileAccountId,
      limit,
    });

    const expectedType = channel === "whatsapp" ? "WHATSAPP" : "LINKEDIN";
    const scoped = items.filter((c) => {
      const t = String(c.account_type || "").toUpperCase();
      return !t || t.includes(expectedType);
    });

    const threads = await Promise.all(
      scoped.map(async (chat) => this.mapChatToThread(workspaceId, channel, account, chat, cfg))
    );

    return {
      workspaceId,
      accountId: account.id,
      unipileAccountId: account.unipileAccountId,
      channel,
      data: threads,
      total: threads.length,
      limit,
      offset: 0,
    };
  }

  private async mapChatToThread(
    workspaceId: string,
    channel: MessagingChannel,
    account: { id: string; unipileAccountId: string; displayName: string | null },
    chat: UnipileChat,
    cfg: Env
  ) {
    let peerName: string | null = chat.name?.trim() || null;
    let peerHeadline: string | null = null;
    let peerPicture: string | null = null;
    let peerProviderId: string | null =
      chat.attendee_provider_id ??
      chat.attendee_public_identifier ??
      chat.provider_id ??
      null;
    let chatKind: "dm" | "group" | "channel" | null = null;
    let preview: string | null = null;

    if (channel === "whatsapp") {
      const wa = whatsappChatTitle(chat);
      peerName = wa.title;
      chatKind = wa.kind;
      peerProviderId = wa.phoneOrJid ?? peerProviderId;
      const last = chat.lastMessage;
      if (last) {
        const t = (last.text ?? last.body ?? "").trim();
        preview = t ? t.slice(0, 120) : null;
      }
    } else if (!peerName || channel === "linkedin") {
      try {
        const attendees = await unipileListChatAttendees(cfg, chat.id);
        const peer = attendees.find((a) => !isTruthyFlag(a.is_self));
        if (peer) {
          peerName = peer.name?.trim() || peerName;
          peerProviderId = peer.provider_id ?? peerProviderId;
          peerPicture = peer.picture_url ?? null;
          const specifics = (peer as UnipileChatAttendee & { specifics?: { occupation?: string } })
            .specifics;
          peerHeadline = specifics?.occupation ?? null;
        }
      } catch {
        // keep fallbacks
      }
    }

    const unread = chat.unread_count ?? chat.unread ?? 0;
    const lastAt = chat.timestamp ?? null;
    const subject = peerName || `${channelLabel(channel)} chat`;

    return {
      id: encodeMessagingThreadId(channel, account.unipileAccountId, chat.id),
      workspaceId,
      inboxId: account.id,
      channel,
      enrollmentId: null,
      prospectId: peerProviderId,
      subject,
      status: unread > 0 ? ("new" as const) : ("replied" as const),
      statusChangedAt: null,
      unreadCount: Number(unread) || 0,
      replyTag: chatKind,
      lastMessageAt: lastAt,
      createdAt: lastAt ?? new Date().toISOString(),
      updatedAt: lastAt ?? new Date().toISOString(),
      prospect: {
        fullName: subject,
        email: channel === "whatsapp" ? peerProviderId ?? undefined : undefined,
        companyName: undefined,
        title: peerHeadline ?? preview ?? undefined,
      },
      unipileChatId: chat.id,
      unipileAccountId: account.unipileAccountId,
      pictureUrl: peerPicture,
      chatKind,
      preview,
    };
  }

  async listMessages(workspaceId: string, threadId: string, limit = 50) {
    const parsed = parseMessagingThreadId(threadId);
    if (!parsed) throw new HttpError("invalid_messaging_thread_id", 400);

    const cfg = await this.resolveConfig(workspaceId);
    if (!isUnipileConfigured(cfg)) {
      throw new HttpError("Messaging is not configured (UNIPILE_API_KEY / UNIPILE_DSN)", 503);
    }
    await this.requireAccountByUnipileId(workspaceId, parsed.channel, parsed.unipileAccountId);

    const { items } = await unipileListChatMessages(cfg, {
      chatId: parsed.chatId,
      limit,
    });

    // Guard against mismatched chat payloads.
    const scoped = items.filter((m) => !m.chat_id || m.chat_id === parsed.chatId);
    const chronological = [...scoped].reverse();
    const data = chronological.map((m) => this.mapMessage(threadId, parsed.channel, m));
    return { threadId, channel: parsed.channel, data, total: data.length };
  }

  private mapMessage(threadId: string, channel: MessagingChannel, m: UnipileChatMessage) {
    const outbound = isTruthyFlag(m.is_sender);
    const text = messageText(m);
    const label = channelLabel(channel).toLowerCase();
    const senderName = senderDisplayName(m);
    return {
      id: m.id,
      threadId,
      direction: outbound ? ("outbound" as const) : ("inbound" as const),
      fromAddress: outbound ? "you" : (senderName || m.sender_id || label),
      toAddress: outbound ? label : "you",
      subject: null,
      bodyText: text || (channel === "whatsapp" ? "[Message]" : null),
      bodyHtml: null,
      classification: null,
      sentAt: messageSentAt(m),
      messageId: m.id,
    };
  }

  async reply(workspaceId: string, threadId: string, text: string) {
    const trimmed = text.trim();
    if (!trimmed) throw new HttpError("reply_text_required", 400);

    const parsed = parseMessagingThreadId(threadId);
    if (!parsed) throw new HttpError("invalid_messaging_thread_id", 400);

    const cfg = await this.resolveConfig(workspaceId);
    if (!isUnipileConfigured(cfg)) {
      throw new HttpError("Messaging is not configured (UNIPILE_API_KEY / UNIPILE_DSN)", 503);
    }
    const account = await this.requireAccountByUnipileId(
      workspaceId,
      parsed.channel,
      parsed.unipileAccountId
    );

    try {
      await unipileSendChatMessage(cfg, {
        chatId: parsed.chatId,
        accountId: account.unipileAccountId,
        text: trimmed,
      });
    } catch (err) {
      if (err instanceof UnipileError) {
        throw new HttpError(err.message || `${parsed.channel}_send_failed`, err.status >= 400 ? err.status : 502);
      }
      throw err;
    }

    const label = channelLabel(parsed.channel).toLowerCase();
    return {
      id: `local-${Date.now()}`,
      threadId,
      direction: "outbound" as const,
      fromAddress: "you",
      toAddress: label,
      subject: null,
      bodyText: trimmed,
      bodyHtml: null,
      classification: null,
      sentAt: new Date().toISOString(),
      messageId: null,
    };
  }

  async markRead(workspaceId: string, threadId: string) {
    const parsed = parseMessagingThreadId(threadId);
    if (!parsed) throw new HttpError("invalid_messaging_thread_id", 400);

    const cfg = await this.resolveConfig(workspaceId);
    if (!isUnipileConfigured(cfg)) {
      throw new HttpError("Messaging is not configured (UNIPILE_API_KEY / UNIPILE_DSN)", 503);
    }
    await this.requireAccountByUnipileId(workspaceId, parsed.channel, parsed.unipileAccountId);

    try {
      await unipileMarkChatRead(cfg, parsed.chatId);
    } catch (err) {
      if (err instanceof UnipileError) {
        throw new HttpError(err.message || "mark_read_failed", err.status >= 400 ? err.status : 502);
      }
      throw err;
    }
    return { ok: true, threadId, unreadCount: 0 };
  }

  async getContext(workspaceId: string, threadId: string) {
    const parsed = parseMessagingThreadId(threadId);
    if (!parsed) throw new HttpError("invalid_messaging_thread_id", 400);

    const cfg = await this.resolveConfig(workspaceId);
    if (!isUnipileConfigured(cfg)) {
      throw new HttpError("Messaging is not configured (UNIPILE_API_KEY / UNIPILE_DSN)", 503);
    }
    await this.requireAccountByUnipileId(workspaceId, parsed.channel, parsed.unipileAccountId);

    let peer: UnipileChatAttendee | undefined;
    try {
      const attendees = await unipileListChatAttendees(cfg, parsed.chatId);
      peer = attendees.find((a) => !isTruthyFlag(a.is_self));
    } catch {
      peer = undefined;
    }

    const specifics = (peer as UnipileChatAttendee & {
      specifics?: { occupation?: string; provider?: string };
    })?.specifics;

    const fullName = peer?.name?.trim() || null;
    return {
      threadId,
      channel: parsed.channel,
      prospect: fullName
        ? {
            prospectId: peer?.provider_id ?? parsed.chatId,
            fullName,
            title: specifics?.occupation ?? null,
            companyDomain: null,
            companyName: null,
            email: parsed.channel === "whatsapp" ? peer?.provider_id ?? null : null,
            industry: null,
            country: null,
            employeeCount: null,
            linkedinUrl:
              parsed.channel === "linkedin" ? null : null,
            pictureUrl: peer?.picture_url ?? null,
            networkProviderId: peer?.provider_id ?? null,
            icpScore: null,
            icpBand: null,
            icpReasoning: null,
            scoredAt: null,
          }
        : null,
      sequence: null,
    };
  }

  async searchPeople(
    workspaceId: string,
    input: {
      accountId?: string;
      mode: "connections" | "search";
      query: string;
      limit?: number;
      cursor?: string;
    }
  ) {
    const cfg = await this.resolveConfig(workspaceId);
    if (!isUnipileConfigured(cfg)) {
      throw new HttpError("Messaging is not configured (UNIPILE_API_KEY / UNIPILE_DSN)", 503);
    }
    const account = await this.requireAccount(workspaceId, "linkedin", input.accountId);
    const limit = input.limit ?? 25;
    const q = input.query.trim();

    if (input.mode === "connections") {
      const { items, cursor } = await unipileListRelations(cfg, {
        accountId: account.unipileAccountId,
        limit,
        filter: q || undefined,
        cursor: input.cursor,
      });
      return {
        workspaceId,
        accountId: account.id,
        mode: "connections" as const,
        data: items.map((r) => mapRelation(r)),
        cursor,
        total: items.length,
      };
    }

    if (!q) throw new HttpError("search_query_required", 400);
    const { items, cursor } = await unipileSearchPeople(cfg, {
      accountId: account.unipileAccountId,
      keywords: q,
      limit,
      cursor: input.cursor,
    });
    return {
      workspaceId,
      accountId: account.id,
      mode: "search" as const,
      data: items.map((p) => mapPeopleSearchItem(p)),
      cursor,
      total: items.length,
    };
  }

  async sendConnectionRequest(
    workspaceId: string,
    input: { accountId?: string; providerId: string; message?: string }
  ) {
    const cfg = await this.resolveConfig(workspaceId);
    if (!isUnipileConfigured(cfg)) {
      throw new HttpError("Messaging is not configured (UNIPILE_API_KEY / UNIPILE_DSN)", 503);
    }
    const account = await this.requireAccount(workspaceId, "linkedin", input.accountId);
    const providerId = input.providerId.trim();
    if (!providerId) throw new HttpError("provider_id_required", 400);

    try {
      await unipileSendInvitation(cfg, {
        accountId: account.unipileAccountId,
        providerId,
        message: input.message?.trim() || null,
      });
    } catch (err) {
      if (err instanceof UnipileError) {
        throw new HttpError(err.message || "linkedin_invite_failed", err.status >= 400 ? err.status : 502);
      }
      throw err;
    }
    return { ok: true, action: "connect" as const, providerId };
  }

  async sendDirectMessage(
    workspaceId: string,
    input: { accountId?: string; providerId: string; text: string }
  ) {
    const cfg = await this.resolveConfig(workspaceId);
    if (!isUnipileConfigured(cfg)) {
      throw new HttpError("Messaging is not configured (UNIPILE_API_KEY / UNIPILE_DSN)", 503);
    }
    const account = await this.requireAccount(workspaceId, "linkedin", input.accountId);
    const providerId = input.providerId.trim();
    const text = input.text.trim();
    if (!providerId) throw new HttpError("provider_id_required", 400);
    if (!text) throw new HttpError("message_text_required", 400);

    try {
      await unipileStartChat(cfg, {
        accountId: account.unipileAccountId,
        providerId,
        text,
      });
    } catch (err) {
      if (err instanceof UnipileError) {
        throw new HttpError(err.message || "linkedin_message_failed", err.status >= 400 ? err.status : 502);
      }
      throw err;
    }
    return { ok: true, action: "message" as const, providerId };
  }

  /** Start a WhatsApp chat by phone number. */
  async sendWhatsappMessage(
    workspaceId: string,
    input: { accountId?: string; phone: string; text: string }
  ) {
    const cfg = await this.resolveConfig(workspaceId);
    if (!isUnipileConfigured(cfg)) {
      throw new HttpError("Messaging is not configured (UNIPILE_API_KEY / UNIPILE_DSN)", 503);
    }
    const account = await this.requireAccount(workspaceId, "whatsapp", input.accountId);
    const attendeeId = normalizeWhatsappAttendeeId(input.phone);
    const text = input.text.trim();
    if (!attendeeId) throw new HttpError("invalid_whatsapp_phone", 400);
    if (!text) throw new HttpError("message_text_required", 400);

    try {
      await unipileSendWhatsapp(cfg, {
        accountId: account.unipileAccountId,
        attendeeId,
        text,
      });
    } catch (err) {
      if (err instanceof UnipileError) {
        throw new HttpError(err.message || "whatsapp_message_failed", err.status >= 400 ? err.status : 502);
      }
      throw err;
    }
    return { ok: true, action: "message" as const, phone: attendeeId };
  }
}

function mapRelation(r: UnipileRelation) {
  const fullName = [r.first_name, r.last_name].filter(Boolean).join(" ").trim();
  return {
    providerId: r.member_id ?? "",
    fullName: fullName || r.public_identifier || "LinkedIn user",
    headline: r.headline ?? null,
    location: null as string | null,
    networkDistance: "DISTANCE_1" as string | null,
    publicIdentifier: r.public_identifier ?? null,
    profileUrl: r.public_profile_url ?? null,
    pictureUrl: r.profile_picture_url ?? null,
    source: "connections" as const,
    canMessage: true,
    canConnect: false,
  };
}

function mapPeopleSearchItem(p: UnipilePeopleSearchItem) {
  const distance = p.network_distance ?? null;
  const firstDegree = distance === "DISTANCE_1" || distance === "FIRST_DEGREE";
  return {
    providerId: p.id,
    fullName: p.name?.trim() || p.public_identifier || "LinkedIn user",
    headline: p.headline ?? null,
    location: p.location ?? null,
    networkDistance: distance,
    publicIdentifier: p.public_identifier ?? null,
    profileUrl: p.public_profile_url ?? p.profile_url ?? null,
    pictureUrl: p.profile_picture_url ?? null,
    source: "search" as const,
    canMessage: firstDegree,
    canConnect: !firstDegree,
  };
}

export function buildMessagingInboxService(db: Db | null | undefined, config: Env) {
  if (!db) return null;
  return new MessagingInboxService(db, config);
}
