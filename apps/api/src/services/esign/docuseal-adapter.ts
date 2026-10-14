import { createHmac, timingSafeEqual } from "node:crypto";
import type { EnvelopeEventStatus } from "@skout/shared";
import type { EsignAdapter, EsignWebhookEvent } from "./esign-adapter.js";

/**
 * COPS-08 DocuSeal adapter (https://www.docuseal.com/docs/api). One Skout envelope is one DocuSeal
 * submission:
 *  - with an e-sign template (CustomerOps admin, provider_template_id = the DocuSeal template id),
 *    POST /submissions from that template;
 *  - without one, POST /submissions/pdf with the uploaded contract version by URL. The PDF must
 *    then carry DocuSeal text tags such as {{Signature;role=First Party}}.
 * Each submitter carries external_id "<envelope id>:<n>", so a repeated send finds the submission
 * already made (GET /submitters?external_id=) instead of mailing the signers twice, and webhooks
 * lead back to the envelope.
 *
 * Webhooks are verified one of two ways, as configured in the DocuSeal console (Webhooks >
 * Security): the HMAC signature (X-Docuseal-Signature: "<unix ts>.<hex HMAC-SHA256 of ts.body>",
 * five minutes' tolerance), or a fixed secret header when DOCUSEAL_WEBHOOK_HEADER names it.
 */
export interface DocusealConfig {
  apiKey: string | undefined;
  /** https://api.docuseal.com (global) or https://api.docuseal.eu; a self-hosted install ends in /api. */
  baseUrl: string;
  webhookSecret: string | undefined;
  /** Name of the secret header set in the console. Unset means HMAC verification. */
  webhookHeader?: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

const EVENTS: Record<string, EnvelopeEventStatus | null> = {
  "submission.created": "sent",
  "form.viewed": "viewed",
  "form.started": "viewed",
  // One signer finishing is not the envelope signed; submission.completed is.
  "form.completed": null,
  "submission.completed": "signed",
  "form.declined": "declined",
  "submission.expired": "expired",
  "submission.archived": null,
};

const TOLERANCE_SECONDS = 300;

function header(headers: Record<string, string | string[] | undefined>, name: string): string | undefined {
  const value = headers[name.toLowerCase()] ?? headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function sameText(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** The signature DocuSeal sends for a body at a time; exported for tests. */
export function docusealSignature(secret: string, timestamp: number, rawBody: string): string {
  return `${timestamp}.${createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex")}`;
}

export function createDocusealAdapter(config: DocusealConfig): EsignAdapter {
  const base = config.baseUrl.replace(/\/$/, "");
  const doFetch = config.fetchImpl ?? fetch;
  const now = config.now ?? (() => Date.now());

  async function call<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    const res = await doFetch(`${base}${path}`, {
      method,
      headers: { "X-Auth-Token": config.apiKey ?? "", ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(20_000),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`DocuSeal ${method} ${path} answered ${res.status}: ${text.slice(0, 160)}`);
    return (text ? JSON.parse(text) : null) as T;
  }

  return {
    provider: "docuseal",
    isConfigured: () => Boolean(config.apiKey && config.webhookSecret),

    async createEnvelope(input) {
      // A retry after a timeout must not send the document again.
      const existing = await call<{ data?: Array<{ submission_id?: number }> }>("GET", `/submitters?external_id=${encodeURIComponent(`${input.referenceId}:0`)}&limit=1`);
      const found = existing?.data?.[0]?.submission_id;
      if (found) return { providerRef: String(found) };

      const submitters = input.signers.map((s, i) => ({
        name: s.name,
        email: s.email,
        ...(s.role ? { role: s.role } : {}),
        external_id: `${input.referenceId}:${i}`,
      }));
      const message = input.message ? { message: { subject: input.title, body: input.message } } : {};
      // Merge fields go in as DocuSeal variables ([[contract_title]] in a template or document).
      const variables = Object.keys(input.mergeFields).length > 0 ? { variables: input.mergeFields } : {};
      if (input.templateId) {
        const templateId = Number(input.templateId);
        if (!Number.isInteger(templateId)) throw new Error(`DocuSeal template ids are numbers; got "${input.templateId}"`);
        const created = await call<Array<{ submission_id?: number }>>("POST", "/submissions", { template_id: templateId, send_email: true, submitters, ...variables, ...message });
        const ref = created?.[0]?.submission_id;
        if (!ref) throw new Error("DocuSeal returned no submission id");
        return { providerRef: String(ref) };
      }
      const created = await call<{ id?: number }>("POST", "/submissions/pdf", {
        name: input.title,
        send_email: true,
        documents: [{ name: input.title, file: input.documentUrl }],
        submitters,
        ...variables,
        ...message,
      });
      if (!created?.id) throw new Error("DocuSeal returned no submission id");
      return { providerRef: String(created.id) };
    },

    verifyWebhook(rawBody, headers) {
      const secret = config.webhookSecret;
      if (!secret) return false;
      if (config.webhookHeader) {
        const given = header(headers, config.webhookHeader);
        return typeof given === "string" && sameText(given, secret);
      }
      const given = header(headers, "x-docuseal-signature");
      if (typeof given !== "string" || !given.includes(".")) return false;
      const timestamp = Number(given.slice(0, given.indexOf(".")));
      if (!Number.isFinite(timestamp) || Math.abs(now() / 1000 - timestamp) > TOLERANCE_SECONDS) return false;
      return sameText(given, docusealSignature(secret, timestamp, rawBody));
    },

    parseWebhook(rawBody): EsignWebhookEvent | null {
      let body: { event_type?: unknown; timestamp?: unknown; data?: Record<string, unknown> };
      try {
        body = JSON.parse(rawBody);
      } catch {
        return null;
      }
      const eventType = typeof body.event_type === "string" ? body.event_type : null;
      const data = body.data;
      if (!eventType || !data || typeof data !== "object") return null;
      // form.* events describe one submitter; submission.* events the whole submission.
      const isForm = eventType.startsWith("form.");
      const submission = (isForm ? data.submission : data) as Record<string, unknown> | undefined;
      const submissionId = submission?.id != null ? String(submission.id) : null;
      const submitters = isForm ? [data] : Array.isArray(data.submitters) ? (data.submitters as Array<Record<string, unknown>>) : [];
      const externalId = submitters.map((s) => s.external_id).find((x): x is string => typeof x === "string" && x.includes(":"));
      const timestamp = typeof body.timestamp === "string" ? body.timestamp : null;
      const occurred = timestamp ? new Date(timestamp) : null;
      // DocuSeal sends no event id; a retry repeats the same type, record and timestamp.
      const eventId = `${eventType}:${isForm ? String(data.id ?? "") : submissionId ?? ""}:${timestamp ?? ""}`;
      return {
        eventId,
        eventType,
        status: eventType in EVENTS ? EVENTS[eventType]! : null,
        providerRef: submissionId,
        referenceId: externalId ? externalId.slice(0, externalId.lastIndexOf(":")) : null,
        occurredAt: occurred && !Number.isNaN(occurred.getTime()) ? occurred : null,
        refs: { event_type: eventType, submission_id: submissionId, submitter_id: isForm ? (data.id ?? null) : null, status: data.status ?? null },
      };
    },
  };
}
