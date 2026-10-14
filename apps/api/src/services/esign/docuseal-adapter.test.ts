import { describe, expect, it, vi } from "vitest";
import { createDocusealAdapter, docusealSignature } from "./docuseal-adapter.js";

const SECRET = "whsec_test_secret_0123456789";
const NOW = Date.parse("2026-10-14T10:00:00Z");
const ts = Math.floor(NOW / 1000);
const ENVELOPE = "8f6b7a52-3c1d-4f7e-9a2b-1c2d3e4f5a6b";

function fakeFetch(routes: Record<string, unknown>) {
  const calls: Array<{ method: string; url: string; body: unknown; token: string | null }> = [];
  const impl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    const method = init?.method ?? "GET";
    calls.push({ method, url: u, body: init?.body ? JSON.parse(String(init.body)) : null, token: new Headers(init?.headers).get("X-Auth-Token") });
    const key = Object.keys(routes).find((k) => `${method} ${u}`.includes(k));
    if (!key) return new Response("not found", { status: 404 });
    return new Response(JSON.stringify(routes[key]), { status: 200 });
  });
  return { impl: impl as unknown as typeof fetch, calls };
}

const adapter = (routes: Record<string, unknown> = {}, extra: Partial<Parameters<typeof createDocusealAdapter>[0]> = {}) => {
  const f = fakeFetch(routes);
  return { a: createDocusealAdapter({ apiKey: "key_test", baseUrl: "https://api.docuseal.com/", webhookSecret: SECRET, fetchImpl: f.impl, now: () => NOW, ...extra }), calls: f.calls };
};
const send = { referenceId: ENVELOPE, title: "Acme MSA", documentUrl: "https://files.test/msa.pdf", fileSha256: "a".repeat(64), signers: [{ name: "Priya Rao", email: "priya@acme.test" }], mergeFields: {} };

describe("DocuSeal webhooks", () => {
  const body = JSON.stringify({ event_type: "submission.completed", timestamp: "2026-10-14T09:59:00Z", data: { id: 42, status: "completed", submitters: [{ id: 7, external_id: `${ENVELOPE}:0`, status: "completed" }] } });

  it("accepts the HMAC signature and refuses a wrong, missing or stale one", () => {
    const { a } = adapter();
    expect(a.verifyWebhook(body, { "x-docuseal-signature": docusealSignature(SECRET, ts, body) })).toBe(true);
    expect(a.verifyWebhook(body, { "x-docuseal-signature": docusealSignature("whsec_other_secret_000000", ts, body) })).toBe(false);
    expect(a.verifyWebhook(body + " ", { "x-docuseal-signature": docusealSignature(SECRET, ts, body) })).toBe(false);
    expect(a.verifyWebhook(body, {})).toBe(false);
    expect(a.verifyWebhook(body, { "x-docuseal-signature": docusealSignature(SECRET, ts - 301, body) })).toBe(false);
    // Without a secret nothing is trusted.
    expect(adapter({}, { webhookSecret: undefined }).a.verifyWebhook(body, { "x-docuseal-signature": docusealSignature(SECRET, ts, body) })).toBe(false);
  });

  it("can verify the console's fixed secret header instead", () => {
    const { a } = adapter({}, { webhookHeader: "X-Skout-Webhook-Secret" });
    expect(a.verifyWebhook(body, { "x-skout-webhook-secret": SECRET })).toBe(true);
    expect(a.verifyWebhook(body, { "x-skout-webhook-secret": "nope-nope-nope-nope-nope" })).toBe(false);
  });

  it("reads a whole-submission event back to our envelope", () => {
    expect(adapter().a.parseWebhook(body, {})).toMatchObject({
      eventType: "submission.completed",
      status: "signed",
      providerRef: "42",
      referenceId: ENVELOPE,
      eventId: "submission.completed:42:2026-10-14T09:59:00Z",
      occurredAt: new Date("2026-10-14T09:59:00Z"),
    });
  });

  it("reads one signer's events: viewed and declined move the envelope, one signer completing does not", () => {
    const form = (event_type: string) => JSON.stringify({ event_type, timestamp: "2026-10-14T09:30:00Z", data: { id: 7, external_id: `${ENVELOPE}:0`, status: "opened", submission: { id: 42 } } });
    const { a } = adapter();
    expect(a.parseWebhook(form("form.viewed"), {})).toMatchObject({ status: "viewed", providerRef: "42", referenceId: ENVELOPE, eventId: "form.viewed:7:2026-10-14T09:30:00Z" });
    expect(a.parseWebhook(form("form.declined"), {})?.status).toBe("declined");
    expect(a.parseWebhook(form("form.completed"), {})?.status).toBeNull();
    expect(a.parseWebhook("not json", {})).toBeNull();
  });
});

describe("DocuSeal sending", () => {
  it("sends from the template, with our envelope id on every signer", async () => {
    const { a, calls } = adapter({ "GET https://api.docuseal.com/submitters": { data: [] }, "POST https://api.docuseal.com/submissions": [{ id: 7, submission_id: 42 }] });
    await expect(a.createEnvelope({ ...send, templateId: "1001", signers: [...send.signers, { name: "Sam Lee", email: "sam@skout.test" }] })).resolves.toEqual({ providerRef: "42" });
    const post = calls.find((c) => c.method === "POST")!;
    expect(post.url).toBe("https://api.docuseal.com/submissions");
    expect(post.token).toBe("key_test");
    expect(post.body).toEqual({
      template_id: 1001,
      send_email: true,
      submitters: [
        { name: "Priya Rao", email: "priya@acme.test", external_id: `${ENVELOPE}:0` },
        { name: "Sam Lee", email: "sam@skout.test", external_id: `${ENVELOPE}:1` },
      ],
    });
  });

  it("without a template, sends the uploaded contract version by its URL", async () => {
    const { a, calls } = adapter({ "GET https://api.docuseal.com/submitters": { data: [] }, "POST https://api.docuseal.com/submissions/pdf": { id: 55 } });
    await expect(a.createEnvelope({ ...send, templateId: null, mergeFields: { contract_title: "Acme MSA", currency: "USD" } })).resolves.toEqual({ providerRef: "55" });
    // Merge fields travel as DocuSeal variables.
    expect(calls.find((c) => c.method === "POST")!.body).toMatchObject({ documents: [{ name: "Acme MSA", file: "https://files.test/msa.pdf" }], variables: { contract_title: "Acme MSA", currency: "USD" } });
  });

  it("a repeated send finds the submission already made and sends nothing", async () => {
    const { a, calls } = adapter({ "GET https://api.docuseal.com/submitters": { data: [{ id: 7, submission_id: 42 }] } });
    await expect(a.createEnvelope({ ...send, templateId: "1001" })).resolves.toEqual({ providerRef: "42" });
    expect(calls.map((c) => c.method)).toEqual(["GET"]);
    expect(calls[0]!.url).toContain(`external_id=${encodeURIComponent(`${ENVELOPE}:0`)}`);
  });

  it("an error from DocuSeal is thrown, and a template id that is not a number is refused", async () => {
    await expect(adapter({ "GET https://api.docuseal.com/submitters": { data: [] } }).a.createEnvelope({ ...send, templateId: "1001" })).rejects.toThrow(/answered 404/);
    await expect(adapter({ "GET https://api.docuseal.com/submitters": { data: [] } }).a.createEnvelope({ ...send, templateId: "tpl_msa" })).rejects.toThrow(/numbers/);
  });
});
