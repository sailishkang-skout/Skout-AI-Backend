import { createHmac, timingSafeEqual } from "node:crypto";
import type { EnvelopeEventStatus } from "@skout/shared";

/**
 * COPS-08 e-signature adapter (Bible p.32, p.82), shaped like the PSP adapter. Skout sends a
 * contract version for signature and learns what happened from signed webhooks. A provider is one
 * implementation of this interface, so changing provider is an adapter change. DocuSeal is the
 * provider (docuseal-adapter.ts); the mock below is for tests and local work.
 */
export interface EsignSigner {
  name: string;
  email: string;
  role?: string;
}

export interface EsignWebhookEvent {
  /** Provider event id, the dedupe key. */
  eventId: string;
  eventType: string;
  /** Status this event implies, or null when the event is not one we act on. */
  status: EnvelopeEventStatus | null;
  /** The provider's id for the envelope. */
  providerRef: string | null;
  /** Our envelope id, when the provider echoes it back. */
  referenceId: string | null;
  /** When it happened at the provider, if it says so. */
  occurredAt: Date | null;
  /** Ids and status kept for reconciliation. Never document content. */
  refs: Record<string, unknown>;
}

export interface EsignAdapter {
  provider: string;
  isConfigured(): boolean;
  /** Must be safe to call again with the same referenceId: the provider must not send the document twice. */
  createEnvelope(input: {
    referenceId: string;
    title: string;
    documentUrl: string;
    fileSha256: string;
    signers: EsignSigner[];
    templateId: string | null;
    mergeFields: Record<string, string>;
    message?: string;
  }): Promise<{ providerRef: string }>;
  /** False when the signature is missing or wrong, or no webhook secret is configured. */
  verifyWebhook(rawBody: string, headers: Record<string, string | string[] | undefined>): boolean;
  parseWebhook(rawBody: string, headers: Record<string, string | string[] | undefined>): EsignWebhookEvent | null;
}

const MOCK_EVENTS: Record<string, EnvelopeEventStatus> = {
  "envelope.sent": "sent",
  "envelope.viewed": "viewed",
  "envelope.signed": "signed",
  "envelope.declined": "declined",
  "envelope.expired": "expired",
};

export function mockEsignSignature(secret: string, rawBody: string): string {
  return createHmac("sha256", secret).update(rawBody).digest("hex");
}

/**
 * Stand-in provider for development and tests. It sends nothing to anyone: createEnvelope only
 * returns a reference, and events arrive when a developer or a test posts them, signed with
 * ESIGN_MOCK_WEBHOOK_SECRET. It is never configured in production.
 */
export function createMockEsignAdapter(opts: { secret: string | undefined; enabled: boolean }): EsignAdapter {
  return {
    provider: "mock",
    isConfigured: () => opts.enabled && Boolean(opts.secret),
    async createEnvelope(input) {
      return { providerRef: `mock_${input.referenceId}` };
    },
    verifyWebhook(rawBody, headers) {
      const given = headers["x-esign-signature"];
      if (!opts.enabled || !opts.secret || typeof given !== "string") return false;
      const expected = Buffer.from(mockEsignSignature(opts.secret, rawBody));
      const actual = Buffer.from(given);
      return expected.length === actual.length && timingSafeEqual(expected, actual);
    },
    parseWebhook(rawBody) {
      try {
        const body = JSON.parse(rawBody) as Record<string, unknown>;
        if (typeof body.event_id !== "string" || typeof body.event_type !== "string") return null;
        const occurred = typeof body.occurred_at === "string" ? new Date(body.occurred_at) : null;
        return {
          eventId: body.event_id,
          eventType: body.event_type,
          status: MOCK_EVENTS[body.event_type] ?? null,
          providerRef: typeof body.envelope_ref === "string" ? body.envelope_ref : null,
          referenceId: typeof body.reference_id === "string" ? body.reference_id : null,
          occurredAt: occurred && !Number.isNaN(occurred.getTime()) ? occurred : null,
          refs: { event_type: body.event_type, envelope_ref: body.envelope_ref ?? null },
        };
      } catch {
        return null;
      }
    },
  };
}
