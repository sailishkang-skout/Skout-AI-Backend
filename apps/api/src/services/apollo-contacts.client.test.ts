import { afterEach, describe, expect, it, vi } from "vitest";
import { ApolloApiError, listApolloContacts, listApolloLists, readApolloContactStages, readApolloLists, searchApolloContacts } from "./apollo-contacts.client.js";
import { apolloContactSource, APOLLO_MAX_RECORDS } from "./import-adapters/apollo.adapter.js";
import type { CrmQuery } from "./crm-record-source.js";

/** How Apollo is read (WB2-024): what is sent, what is understood, and what each refusal becomes. */
const answer = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers });
function apolloAnswers(...responses: Array<Response | Error>) {
  const calls: Array<{ url: string; init: RequestInit; body: Record<string, unknown> }> = [];
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    calls.push({ url, init, body: init.body ? JSON.parse(String(init.body)) : {} });
    const next = responses.length > 1 ? responses.shift()! : responses[0]!;
    if (next instanceof Error) throw next;
    return next.clone();
  });
  return calls;
}
const search = (contacts: unknown[], total = contacts.length, perPage = 100) => answer({ contacts, pagination: { page: 1, per_page: perPage, total_entries: total, total_pages: Math.ceil(total / perPage) } });
const query = (extra: Partial<CrmQuery> = {}): CrmQuery => ({ object: "contact", fields: ["name", "email"], filters: [], ...extra });
const some = (count: number) => Array.from({ length: count }, (_, i) => ({ id: `c${i}`, name: `Person ${i}` }));

afterEach(() => vi.unstubAllGlobals());

describe("Apollo requests", () => {
  it("send the key in the header only, to Apollo's API, without following redirects", async () => {
    const calls = apolloAnswers(search([]));
    await searchApolloContacts("the-key-123", { page: 2, perPage: 100, listId: "l1", keywords: "cto", stageIds: ["s1"] });
    expect(calls[0]!.url).toBe("https://api.apollo.io/api/v1/contacts/search");
    expect(calls[0]!.init).toMatchObject({ method: "POST", redirect: "error" });
    expect((calls[0]!.init.headers as Record<string, string>)["x-api-key"]).toBe("the-key-123");
    expect(calls[0]!.body).toEqual({ page: 2, per_page: 100, sort_by_field: "contact_created_at", sort_ascending: true, contact_label_ids: ["l1"], q_keywords: "cto", contact_stage_ids: ["s1"] });
    expect(JSON.stringify(calls[0]!.body) + calls[0]!.url).not.toContain("the-key-123");
  });

  it.each([
    ["a bare array, as Apollo documents", [{ id: "l1", name: "One", cached_count: 4, modality: "contacts" }, { _id: "l2", name: "Two" }, { id: "a", name: "Accounts", modality: "accounts" }]],
    ["an object holding them", { labels: [{ id: "l1", name: "One", count: 4 }, { id: "l2", name: "Two" }] }],
  ])("read contact lists from %s", async (_what, body) => {
    apolloAnswers(answer(body));
    expect(await readApolloLists("k")).toEqual([{ id: "l1", name: "One", count: 4 }, { id: "l2", name: "Two", count: null }]);
  });

  it("read contact stages", async () => {
    const calls = apolloAnswers(answer({ contact_stages: [{ id: "s1", name: "cold", display_name: "Cold" }, { id: "s2" }] }));
    expect(await readApolloContactStages("k")).toEqual([{ id: "s1", name: "Cold" }]);
    expect(calls[0]!.init.method).toBe("GET");
  });

  it.each([
    ["no contacts", answer({ people: [] })],
    ["a contact without an id", answer({ contacts: [{ name: "x" }] })],
    ["something that isn't JSON", answer("<html>")],
    ["no answer", new TypeError("network")],
  ])("treat an answer with %s as Apollo being unavailable, not as empty", async (_what, response) => {
    apolloAnswers(response);
    await expect(searchApolloContacts("k", { page: 1, perPage: 100 })).rejects.toMatchObject({ status: 0 });
  });

  it("keep the status and how long to wait, and nothing Apollo said", async () => {
    apolloAnswers(answer("secret detail", 429, { "retry-after": "120" }));
    const error = await searchApolloContacts("k", { page: 1, perPage: 1 }).catch((e) => e);
    expect(error).toBeInstanceOf(ApolloApiError);
    expect(error).toMatchObject({ status: 429, retryAfterMs: 120_000 });
    expect(`${error.message}${JSON.stringify(error)}`).not.toContain("secret detail");
    apolloAnswers(answer("busy", 429));
    await expect(readApolloLists("k")).rejects.toMatchObject({ retryAfterMs: 60_000 });
  });

  it("drop text a database cannot hold", async () => {
    apolloAnswers(search([{ id: "c1", name: "A\u0000da", title: "  " }]));
    const { contacts } = await searchApolloContacts("k", { page: 1, perPage: 1 });
    expect(contacts[0]).toMatchObject({ fullName: "Ada", title: undefined });
  });

  it("for the earlier import routes, filter by list the documented way and answer as before", async () => {
    const calls = apolloAnswers(search(some(100)), search(some(3)));
    expect(await listApolloContacts("k", "l1", 500)).toHaveLength(103);
    expect(calls.map((c) => [c.body.page, c.body.contact_label_ids])).toEqual([[1, ["l1"]], [2, ["l1"]]]);
    apolloAnswers(answer("no", 401));
    await expect(listApolloLists("k")).rejects.toMatchObject({ message: "apollo_unauthorized", statusCode: 401 });
    apolloAnswers(answer("no", 500));
    await expect(listApolloContacts("k", undefined)).rejects.toMatchObject({ message: "apollo_request_failed", statusCode: 502 });
  });
});

describe("the Apollo record source", () => {
  it("returns only the fields asked for", async () => {
    apolloAnswers(search([{ id: "c1", person_id: "p1", first_name: "Ada", last_name: "Lovelace", email: "ada@example.com", title: "Dev" }]));
    expect(await apolloContactSource.page("k", query(), null, 100)).toEqual({
      records: [{ id: "c1", properties: { name: "Ada Lovelace", email: "ada@example.com" }, ref: { personId: "p1" } }],
      next: null,
      total: 1,
    });
  });

  it("walks the pages Apollo says there are", async () => {
    const calls = apolloAnswers(search(some(100), 250));
    expect((await apolloContactSource.page("k", query(), null, 100)).next).toBe("2");
    expect((await apolloContactSource.page("k", query(), "2", 100)).next).toBe("3");
    expect((await apolloContactSource.page("k", query(), "3", 100)).next).toBeNull();
    expect(calls.map((c) => c.body.page)).toEqual([1, 2, 3]);
  });

  it("ends on an empty page whatever the totals say", async () => {
    apolloAnswers(search([], 900));
    expect((await apolloContactSource.page("k", query(), "4", 100)).next).toBeNull();
  });

  it("goes on while pages are full when Apollo gives no totals", async () => {
    apolloAnswers(answer({ contacts: some(100) }));
    expect(await apolloContactSource.page("k", query(), null, 100)).toMatchObject({ next: "2", total: null });
    apolloAnswers(answer({ contacts: some(7) }));
    expect((await apolloContactSource.page("k", query(), "2", 100)).next).toBeNull();
  });

  it("stops at Apollo's display limit and says there was more", async () => {
    apolloAnswers(search(some(100), APOLLO_MAX_RECORDS + 1));
    expect(await apolloContactSource.page("k", query(), "499", 100)).toMatchObject({ next: "500" });
    expect(await apolloContactSource.page("k", query(), "499", 100)).not.toHaveProperty("limited");
    expect(await apolloContactSource.page("k", query(), "500", 100)).toMatchObject({ next: null, limited: true });
  });

  it("doesn't claim there was more when the selection ends at the limit", async () => {
    apolloAnswers(search(some(100), APOLLO_MAX_RECORDS));
    const last = await apolloContactSource.page("k", query(), "500", 100);
    expect(last.next).toBeNull();
    expect(last).not.toHaveProperty("limited");
  });

  it("counts a selection with one small read", async () => {
    const calls = apolloAnswers(search(some(1), 812, 1));
    expect(await apolloContactSource.count("k", query({ viewId: "l1" }))).toBe(812);
    expect(calls[0]!.body).toMatchObject({ per_page: 1, contact_label_ids: ["l1"] });
  });

  it.each([
    [401, "reauth", false],
    [403, "scope", false],
    [429, "rate_limited", true],
    [400, "rejected", false],
    [422, "rejected", false],
    [404, "unavailable", true],
    [503, "unavailable", true],
  ])("reads a %i as %s", async (status, failure, retryable) => {
    apolloAnswers(answer("no", status));
    await expect(apolloContactSource.page("k", query(), null, 100)).rejects.toMatchObject({ failure, retryable });
    await expect(apolloContactSource.listViews("k", "contact")).rejects.toMatchObject({ failure });
    await expect(apolloContactSource.listStages!("k")).rejects.toMatchObject({ failure });
  });
});
