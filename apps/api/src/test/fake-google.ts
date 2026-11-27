/**
 * A stand-in for the parts of Google that Sheets import uses (WB2-025): the token and revoke endpoints, reading a
 * spreadsheet's tabs, and reading a range of values. It follows Google's documented shapes closely enough to catch a
 * wrong request (the readonly scope, bearer headers, A1 ranges, trailing empty rows and cells left out), but it is not
 * Google: only a real account can show that Google accepts what Skout sends.
 */
export const READONLY_SCOPE = "https://www.googleapis.com/auth/spreadsheets.readonly";

export interface FakeTab {
  sheetId: number;
  title: string;
  /** Row 1 first. A row may be shorter than the others. */
  values: string[][];
  /** The grid's size; by default, what the values need plus some empty rows. */
  rowCount?: number;
  columnCount?: number;
  sheetType?: string;
}

export interface FakeSpreadsheet {
  id: string;
  title: string;
  tabs: FakeTab[];
  /** Accounts that can open it. */
  readers: Set<string>;
}

export interface FakeGoogleCall {
  method: string;
  host: string;
  path: string;
  url: string;
  /** The account whose access token was sent. */
  account: string | null;
  authorization: string | null;
  form: Record<string, string>;
  range?: string;
}

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const refused = (status: number, reason?: string, message = "secret detail from Google") =>
  json(status, { error: { code: status, message, ...(reason ? { details: [{ reason }] } : {}) } });

const column = (letters: string) => [...letters].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0);

export class FakeGoogle {
  spreadsheets = new Map<string, FakeSpreadsheet>();
  calls: FakeGoogleCall[] = [];
  /** Live access and refresh tokens, by the account they act for. */
  access = new Map<string, string>();
  refresh = new Map<string, string>();
  /** What a sign-in grants. */
  grantedScope = READONLY_SCOPE;
  issueRefreshToken = true;
  expiresIn = 3_600;
  revokeStatus = 200;
  private codes = new Map<string, string>();
  private serial = 0;
  private failures: Array<{ match: (call: FakeGoogleCall) => boolean; status: number; reason?: string; message?: string; times: number }> = [];
  onCall: ((call: FakeGoogleCall) => void | Promise<void>) | null = null;

  reset() {
    this.spreadsheets.clear();
    this.calls = [];
    this.access.clear();
    this.refresh.clear();
    this.codes.clear();
    this.failures = [];
    this.grantedScope = READONLY_SCOPE;
    this.issueRefreshToken = true;
    this.expiresIn = 3_600;
    this.revokeStatus = 200;
    this.onCall = null;
  }

  /** The code Google would send back after `account` consents. */
  consent(account: string): string {
    const code = `code-secret-${account}-${++this.serial}`;
    this.codes.set(code, account);
    return code;
  }

  /** The person removes Skout's access in their Google account. */
  removeAccess(account: string) {
    for (const tokens of [this.access, this.refresh]) for (const [token, owner] of tokens) if (owner === account) tokens.delete(token);
  }

  add(spreadsheet: Omit<FakeSpreadsheet, "readers">, ...readers: string[]) {
    const made = { ...spreadsheet, readers: new Set(readers) };
    this.spreadsheets.set(made.id, made);
    return made;
  }

  fail(match: (call: FakeGoogleCall) => boolean, status: number, options: { times?: number; reason?: string; message?: string } = {}) {
    this.failures.push({ match, status, times: options.times ?? 1, reason: options.reason, message: options.message });
  }

  valueReads() {
    return this.calls.filter((c) => c.range !== undefined);
  }

  handles(url: string) {
    return /^https:\/\/(oauth2|sheets)\.googleapis\.com\//.test(url);
  }

  fetch = async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    const authorization = new Headers(init.headers).get("authorization");
    const form = init.body instanceof URLSearchParams ? Object.fromEntries(init.body) : {};
    const values = /^\/v4\/spreadsheets\/[^/]+\/values\/(.+)$/.exec(url.pathname);
    const call: FakeGoogleCall = {
      method: init.method ?? "GET",
      host: url.hostname,
      path: url.pathname,
      url: url.toString(),
      account: this.access.get(authorization?.replace(/^Bearer /, "") ?? "") ?? null,
      authorization,
      form,
      ...(values ? { range: decodeURIComponent(values[1]!) } : {}),
    };
    this.calls.push(call);
    await this.onCall?.(call);
    const failure = this.failures.find((f) => f.times > 0 && f.match(call));
    if (failure) {
      failure.times -= 1;
      return refused(failure.status, failure.reason, failure.message);
    }
    if (url.hostname === "oauth2.googleapis.com") return this.oauth(call);
    return this.sheets(call, url);
  };

  private oauth({ method, path, form }: FakeGoogleCall): Response {
    if (method !== "POST") return refused(405);
    if (path === "/revoke") {
      if (this.revokeStatus !== 200) return refused(this.revokeStatus);
      const account = this.refresh.get(form.token ?? "") ?? this.access.get(form.token ?? "");
      if (!account) return json(400, { error: "invalid_token" });
      this.removeAccess(account);
      return json(200, {});
    }
    if (path !== "/token" || !form.client_id || !form.client_secret) return json(400, { error: "invalid_request" });
    let account: string | undefined;
    if (form.grant_type === "authorization_code") {
      account = this.codes.get(form.code ?? "");
      // A code works once.
      this.codes.delete(form.code ?? "");
      if (!form.redirect_uri) account = undefined;
    } else if (form.grant_type === "refresh_token") account = this.refresh.get(form.refresh_token ?? "");
    if (!account) return json(400, { error: "invalid_grant", error_description: "secret detail from Google" });
    const accessToken = `ya29-secret-${account}-${++this.serial}`;
    this.access.set(accessToken, account);
    const body: Record<string, unknown> = { access_token: accessToken, expires_in: this.expiresIn, scope: this.grantedScope, token_type: "Bearer" };
    if (form.grant_type === "authorization_code" && this.issueRefreshToken) {
      const refreshToken = `refresh-secret-${account}-${++this.serial}`;
      this.refresh.set(refreshToken, account);
      body.refresh_token = refreshToken;
    }
    return json(200, body);
  }

  private sheets(call: FakeGoogleCall, url: URL): Response {
    if (call.method !== "GET") return refused(403, "ACCESS_TOKEN_SCOPE_INSUFFICIENT");
    if (!call.account) return refused(401);
    const id = decodeURIComponent(/^\/v4\/spreadsheets\/([^/]+)/.exec(url.pathname)?.[1] ?? "");
    const spreadsheet = this.spreadsheets.get(id);
    if (!spreadsheet) return refused(404);
    if (!spreadsheet.readers.has(call.account)) return refused(403);
    const grid = (tab: FakeTab) => ({
      rowCount: tab.rowCount ?? tab.values.length + 50,
      columnCount: tab.columnCount ?? Math.max(26, ...tab.values.map((r) => r.length)),
    });
    if (call.range === undefined) {
      return json(200, {
        properties: { title: spreadsheet.title },
        sheets: spreadsheet.tabs.map((t) => ({ properties: { sheetId: t.sheetId, title: t.title, sheetType: t.sheetType ?? "GRID", gridProperties: grid(t) } })),
      });
    }
    const range = /^'((?:[^']|'')+)'!A(\d+):([A-Z]+)(\d+)$/.exec(call.range);
    const tab = range && spreadsheet.tabs.find((t) => t.title === range[1]!.replaceAll("''", "'"));
    if (!range || !tab) return refused(400, undefined, `Unable to parse range: ${call.range}`);
    const [from, width, to] = [Number(range[2]), column(range[3]!), Number(range[4])];
    if (from < 1 || to < from || to > grid(tab).rowCount || width > grid(tab).columnCount) return refused(400, undefined, "Range exceeds grid limits");
    const rows = tab.values.slice(from - 1, to).map((row) => {
      const cells = row.slice(0, width);
      while (cells.length && cells[cells.length - 1] === "") cells.pop();
      return cells;
    });
    while (rows.length && !rows[rows.length - 1]!.length) rows.pop();
    return json(200, { range: call.range, majorDimension: "ROWS", ...(rows.length ? { values: rows } : {}) });
  }
}
