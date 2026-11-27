/**
 * A stand-in for the parts of Apollo's API that importing uses (WB2-024): lists, contact stages, the search of saved
 * contacts, and the key check made when a key is saved. It follows Apollo's published reference (the `x-api-key`
 * header, a bare array of lists, `contact_label_ids`, 100 records a page, 500 pages) and refuses anything else, so a
 * wrong request is caught. It is not Apollo: only a real account can show that Apollo accepts what Skout sends.
 */
export interface FakeContact {
  id: string;
  [field: string]: unknown;
}

export interface FakeApolloList {
  id: string;
  name: string;
  modality?: string;
  members: string[];
  /** What Apollo reports as its size; the true count unless set. */
  cachedCount?: number;
}

export interface FakeApolloCall {
  method: string;
  path: string;
  key: string | null;
  url: string;
  body: Record<string, unknown>;
}

const SEARCH_PARAMETERS = ["page", "per_page", "sort_by_field", "sort_ascending", "contact_label_ids", "q_keywords", "contact_stage_ids"];

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

export class FakeApollo {
  keys = new Set<string>();
  /** Endpoints a key may not call, as a key without that access is answered. */
  forbidden = new Map<string, Set<string>>();
  contacts = new Map<string, FakeContact[]>();
  lists: FakeApolloList[] = [];
  stages: Array<{ id: string; name: string; display_name?: string }> = [];
  calls: FakeApolloCall[] = [];
  private failures: Array<{ match: (call: FakeApolloCall) => boolean; status: number; times: number; headers?: Record<string, string> }> = [];
  /** Run before a call is answered, to change things while an import is reading. */
  onCall: ((call: FakeApolloCall) => void | Promise<void>) | null = null;

  reset() {
    this.keys.clear();
    this.forbidden.clear();
    this.contacts.clear();
    this.lists = [];
    this.stages = [];
    this.calls = [];
    this.failures = [];
    this.onCall = null;
  }

  /** Answers matching calls with an error, `times` times. */
  fail(match: (call: FakeApolloCall) => boolean, status: number, options: { times?: number; headers?: Record<string, string> } = {}) {
    this.failures.push({ match, status, times: options.times ?? 1, headers: options.headers });
  }

  /** The saved contacts of the account a key belongs to, with ids counting up from `first`. */
  add(key: string, count: number, make: (i: number) => Record<string, unknown>, first = 1) {
    this.keys.add(key);
    const added = Array.from({ length: count }, (_, i) => ({ id: `contact-${first + i}`, ...make(first + i) }));
    this.contacts.set(key, [...(this.contacts.get(key) ?? []), ...added]);
    return added.map((c) => c.id);
  }

  searches() {
    return this.calls.filter((c) => c.path === "/api/v1/contacts/search");
  }

  fetch = async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    const headers = new Headers(init.headers);
    const call: FakeApolloCall = {
      method: init.method ?? "GET",
      path: url.pathname,
      key: headers.get("x-api-key"),
      url: url.toString(),
      body: init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {},
    };
    this.calls.push(call);
    await this.onCall?.(call);

    const failure = this.failures.find((f) => f.times > 0 && f.match(call));
    if (failure) {
      failure.times -= 1;
      return json(failure.status, { error: "secret detail from Apollo" }, failure.headers);
    }
    // The check made when a key is saved, which the integration service sends the way it always has.
    if (call.path === "/v1/auth/health") return json(200, { healthy: true, is_logged_in: this.keys.has(String(call.body.api_key)) });
    if (!call.key || !this.keys.has(call.key)) return new Response("Invalid API key. secret detail", { status: 401 });
    if (this.forbidden.get(call.key)?.has(call.path)) return json(403, { error_code: "API_INACCESSIBLE", error: "secret detail" });

    if (call.path === "/api/v1/labels" && call.method === "GET") {
      return json(
        200,
        this.lists.map((l) => ({ _id: l.id, id: l.id, name: l.name, modality: l.modality ?? "contacts", cached_count: l.cachedCount ?? l.members.length, team_id: "team-1" }))
      );
    }
    if (call.path === "/api/v1/contact_stages" && call.method === "GET") return json(200, { contact_stages: this.stages });
    if (call.path === "/api/v1/contacts/search" && call.method === "POST") return this.search(call);
    return json(404, { error: "no such endpoint" });
  };

  private search({ body, key }: FakeApolloCall): Response {
    const unknown = Object.keys(body).filter((k) => !SEARCH_PARAMETERS.includes(k));
    if (unknown.length) return json(422, { error: `unknown parameters ${unknown.join(", ")}` });
    const page = Number(body.page ?? 1);
    const perPage = Number(body.per_page ?? 25);
    if (page < 1 || page > 500 || perPage < 1 || perPage > 100) return json(422, { error: "beyond the display limit" });
    let found = this.contacts.get(key!) ?? [];
    const listIds = body.contact_label_ids as string[] | undefined;
    if (listIds) {
      const members = new Set(this.lists.filter((l) => listIds.includes(l.id)).flatMap((l) => l.members));
      found = found.filter((c) => members.has(c.id));
    }
    const stageIds = body.contact_stage_ids as string[] | undefined;
    if (stageIds) found = found.filter((c) => stageIds.includes(String(c.contact_stage_id)));
    const keywords = (body.q_keywords as string | undefined)?.toLowerCase();
    if (keywords) found = found.filter((c) => [c.name, c.title, c.organization_name, c.email].some((v) => String(v ?? "").toLowerCase().includes(keywords)));
    return json(200, {
      contacts: found.slice((page - 1) * perPage, page * perPage),
      pagination: { page, per_page: perPage, total_entries: found.length, total_pages: Math.ceil(found.length / perPage) },
    });
  }
}
