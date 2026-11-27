/**
 * A stand-in for the parts of HubSpot's API that importing uses (WB2-023): token info and refresh, properties, lists
 * and their members, and reading, batch-reading and searching contacts and companies. It follows HubSpot's documented
 * shapes and limits closely enough to catch a wrong request, but it is not HubSpot: only a real account can show that
 * HubSpot accepts what Skout sends.
 */
export type FakeObjectType = "contacts" | "companies";

export interface FakeRecord {
  id: string;
  properties: Record<string, string | null>;
}

export interface FakeList {
  listId: string;
  name: string;
  objectType: FakeObjectType;
  members: string[];
  /** What HubSpot reports as its size; the true count unless set. */
  size?: number;
}

interface FakeProperty {
  name: string;
  label: string;
  type: string;
  fieldType: string;
  hidden?: boolean;
}

const property = (name: string, label: string, type = "string", fieldType = "text"): FakeProperty => ({ name, label, type, fieldType });

export const FAKE_PROPERTIES: Record<FakeObjectType, FakeProperty[]> = {
  contacts: [
    property("firstname", "First name"),
    property("lastname", "Last name"),
    property("email", "Email"),
    property("jobtitle", "Job title"),
    property("company", "Company name"),
    property("phone", "Phone number", "string", "phonenumber"),
    property("website", "Website URL"),
    property("score", "Lead score", "number", "number"),
    property("signed_up", "Signed up", "date", "date"),
    property("createdate", "Create date", "datetime", "date"),
    property("subscribed", "Subscribed", "bool", "booleancheckbox"),
    property("lifecyclestage", "Lifecycle stage", "enumeration", "radio"),
    property("hs_object_id", "Record ID", "number", "number"),
    { ...property("hs_internal", "Internal"), hidden: true },
  ],
  companies: [
    property("name", "Company name"),
    property("domain", "Company domain name"),
    property("website", "Website URL"),
    property("industry", "Industry", "enumeration", "select"),
    property("phone", "Phone number", "string", "phonenumber"),
    property("city", "City"),
    property("country", "Country/Region"),
    property("numberofemployees", "Number of employees", "number", "number"),
    property("hs_object_id", "Record ID", "number", "number"),
  ],
};

export const ALL_SCOPES = ["crm.objects.contacts.read", "crm.objects.contacts.write", "crm.objects.companies.read", "crm.schemas.companies.read", "crm.schemas.contacts.read", "crm.lists.read"];

export interface FakeCall {
  method: string;
  path: string;
  query: Record<string, string>;
  body: any;
  token: string | null;
}

interface Failure {
  match: (call: FakeCall) => boolean;
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
  times: number;
}

export class FakeHubSpot {
  portalId = "1234567";
  scopes = new Set(ALL_SCOPES);
  tokens = new Set(["token-1"]);
  /** The sign-in code that can be exchanged, and what it gives. */
  authorization = { code: "authorized", issues: "token-connected" };
  /** The refresh token that still works, and what it gives. */
  refresh = { token: "refresh-1", issues: "token-2", revoked: false };
  records: Record<FakeObjectType, FakeRecord[]> = { contacts: [], companies: [] };
  lists: FakeList[] = [];
  calls: FakeCall[] = [];
  /** Called before each answer, to change things part way through. */
  onCall: ((call: FakeCall) => void | Promise<void>) | null = null;
  private failures: Failure[] = [];

  reset() {
    this.portalId = "1234567";
    this.scopes = new Set(ALL_SCOPES);
    this.tokens = new Set(["token-1"]);
    this.refresh = { token: "refresh-1", issues: "token-2", revoked: false };
    this.records = { contacts: [], companies: [] };
    this.lists = [];
    this.calls = [];
    this.failures = [];
    this.onCall = null;
  }

  /** Answers matching calls with an error, `times` times. */
  fail(match: (call: FakeCall) => boolean, status: number, options: { times?: number; body?: unknown; headers?: Record<string, string> } = {}) {
    this.failures.push({ match, status, times: options.times ?? 1, body: options.body, headers: options.headers });
  }

  /** Records with ids counting up from `first`. */
  add(type: FakeObjectType, count: number, make: (i: number) => Record<string, string | null>, first = 1_001) {
    const added = Array.from({ length: count }, (_, i) => ({ id: String(first + i), properties: { ...make(i), hs_object_id: String(first + i) } }));
    this.records[type].push(...added);
    return added.map((r) => r.id);
  }

  fetch = async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    const headers = new Headers(init.headers);
    const raw = typeof init.body === "string" ? init.body : init.body instanceof URLSearchParams ? init.body.toString() : "";
    let body: any = null;
    if (raw) body = raw.startsWith("{") ? JSON.parse(raw) : Object.fromEntries(new URLSearchParams(raw));
    const call: FakeCall = {
      method: (init.method ?? "GET").toUpperCase(),
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      body,
      token: headers.get("authorization")?.replace(/^Bearer /, "") ?? null,
    };
    this.calls.push(call);
    await this.onCall?.(call);
    const failure = this.failures.find((f) => f.times > 0 && f.match(call));
    if (failure) {
      failure.times -= 1;
      return json(failure.status, failure.body ?? { status: "error", message: "fake failure: secret detail from HubSpot" }, failure.headers);
    }
    return this.answer(call);
  };

  private answer(call: FakeCall): Response {
    const { method, path, query, body } = call;
    if (path === "/oauth/v1/token") {
      if (body?.grant_type === "authorization_code") {
        if (body.code !== this.authorization.code) return json(400, { status: "BAD_AUTH_CODE" });
        this.tokens.add(this.authorization.issues);
        return json(200, { access_token: this.authorization.issues, refresh_token: this.refresh.token, expires_in: 1800 });
      }
      if (this.refresh.revoked || body?.refresh_token !== this.refresh.token) return json(400, { status: "BAD_REFRESH_TOKEN", message: "refresh token is invalid, invalid_grant" });
      this.tokens.add(this.refresh.issues);
      return json(200, { access_token: this.refresh.issues, refresh_token: this.refresh.token, expires_in: 1800 });
    }
    const info = /^\/oauth\/v1\/access-tokens\/(.+)$/.exec(path);
    if (info) return this.tokens.has(decodeURIComponent(info[1]!)) ? json(200, { hub_id: Number(this.portalId) }) : json(401, { message: "expired" });
    if (!call.token || !this.tokens.has(call.token)) return json(401, { status: "error", category: "EXPIRED_AUTHENTICATION", message: "expired" });

    const needs = (scope: string) => (this.scopes.has(scope) ? null : json(403, { status: "error", category: "MISSING_SCOPES", message: `requires ${scope}` }));
    const properties = /^\/crm\/v3\/properties\/(contacts|companies)$/.exec(path);
    if (properties) {
      const type = properties[1] as FakeObjectType;
      return needs(`crm.schemas.${type}.read`) ?? json(200, { results: FAKE_PROPERTIES[type] });
    }
    if (path === "/crm/v3/lists/search") {
      const refused = needs("crm.lists.read");
      if (refused) return refused;
      const type: FakeObjectType = body.objectTypeId === "0-2" ? "companies" : "contacts";
      const mine = this.lists.filter((l) => l.objectType === type);
      const page = mine.slice(body.offset ?? 0, (body.offset ?? 0) + body.count);
      return json(200, {
        lists: page.map((l) => ({ listId: l.listId, name: l.name, objectTypeId: body.objectTypeId, additionalProperties: { hs_list_size: String(l.size ?? l.members.length) } })),
        hasMore: (body.offset ?? 0) + page.length < mine.length,
      });
    }
    const memberships = /^\/crm\/v3\/lists\/([^/]+)\/memberships$/.exec(path);
    if (memberships) {
      const refused = needs("crm.lists.read");
      if (refused) return refused;
      const list = this.lists.find((l) => l.listId === decodeURIComponent(memberships[1]!));
      if (!list) return json(404, { status: "error", message: "no such list" });
      const from = Number(query.after ?? 0);
      const limit = Number(query.limit ?? 100);
      const next = from + limit < list.members.length ? { next: { after: String(from + limit) } } : undefined;
      return json(200, { results: list.members.slice(from, from + limit).map((recordId) => ({ recordId })), paging: next });
    }
    const write = /^\/crm\/v3\/objects\/(contacts|companies)\/(\d+)$/.exec(path);
    if (write && method === "PATCH") {
      const record = this.records[write[1] as FakeObjectType].find((r) => r.id === write[2]);
      if (!record) return json(404, { status: "error" });
      Object.assign(record.properties, body.properties);
      return json(200, record);
    }
    const objects = /^\/crm\/v3\/objects\/(contacts|companies)(\/batch\/read|\/search)?$/.exec(path);
    if (!objects) return json(404, { status: "error", message: "not part of the stand-in" });
    const type = objects[1] as FakeObjectType;
    const refused = needs(`crm.objects.${type}.read`);
    if (refused) return refused;
    const known = new Set(FAKE_PROPERTIES[type].map((p) => p.name));
    const wanted: string[] = Array.isArray(body?.properties) ? body.properties : (query.properties ?? "").split(",").filter(Boolean);
    const shown = (r: FakeRecord) => ({ id: r.id, properties: Object.fromEntries([...wanted.filter((p) => known.has(p)), "hs_object_id"].map((p) => [p, r.properties[p] ?? null])) });
    const sorted = [...this.records[type]].sort((a, b) => Number(a.id) - Number(b.id));

    if (objects[2] === "/batch/read") {
      if (body.inputs.length > 100) return json(400, { message: "at most 100 inputs" });
      const ids = new Set(body.inputs.map((i: { id: string }) => i.id));
      // HubSpot answers in its own order.
      return json(200, { results: sorted.filter((r) => ids.has(r.id)).reverse().map(shown) });
    }
    if (objects[2] === "/search") {
      const groups: Array<{ filters: Array<{ propertyName: string; operator: string; value?: string }> }> = body.filterGroups ?? [];
      if (groups.some((g) => g.filters.length > 6) || body.limit > 200) return json(400, { message: "too many filters or too large a page" });
      const filters = groups[0]?.filters ?? [];
      if (filters.some((f) => !known.has(f.propertyName))) return json(400, { message: "unknown property" });
      const matches = sorted.filter((r) => filters.every((f) => passes(FAKE_PROPERTIES[type].find((p) => p.name === f.propertyName)!, r.properties[f.propertyName] ?? null, f)));
      return json(200, { total: matches.length, results: matches.slice(0, body.limit).map(shown) });
    }
    const from = Number(query.after ?? 0);
    const limit = Number(query.limit ?? 10);
    if (limit > 100) return json(400, { message: "limit is at most 100" });
    const next = from + limit < sorted.length ? { next: { after: String(from + limit) } } : undefined;
    return json(200, { results: sorted.slice(from, from + limit).map(shown), paging: next });
  }
}

function passes(property: FakeProperty, actual: string | null, filter: { operator: string; value?: string }): boolean {
  if (filter.operator === "HAS_PROPERTY") return Boolean(actual);
  if (filter.operator === "NOT_HAS_PROPERTY") return !actual;
  if (actual === null || actual === "") return filter.operator === "NEQ" || filter.operator === "NOT_CONTAINS_TOKEN";
  const dated = property.type === "date" || property.type === "datetime";
  const numeric = dated || property.type === "number";
  // HubSpot takes dates in filters as milliseconds.
  const left = dated ? Date.parse(actual) : numeric ? Number(actual) : actual.toLowerCase();
  const right = numeric ? Number(filter.value) : String(filter.value).toLowerCase();
  if (numeric && Number.isNaN(right)) return false;
  switch (filter.operator) {
    case "EQ":
      return left === right;
    case "NEQ":
      return left !== right;
    case "CONTAINS_TOKEN":
      return String(left).includes(String(right));
    case "NOT_CONTAINS_TOKEN":
      return !String(left).includes(String(right));
    case "GT":
      return left > right;
    case "GTE":
      return left >= right;
    case "LT":
      return left < right;
    case "LTE":
      return left <= right;
    default:
      return false;
  }
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
