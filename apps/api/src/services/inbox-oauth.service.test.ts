import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  getGoogleConnectUrl,
  getMicrosoftConnectUrl,
  handleGoogleCallback,
  handleMicrosoftCallback,
  resolveAccessToken,
} from "./inbox-oauth.service.js";
import { HttpError } from "../utils/http.js";
import { encryptSecret } from "../utils/integration-crypto.js";
import { signOAuthState } from "../utils/oauth-state.js";
import type { Env } from "../config/env.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ENC_KEY = "test-key-32-bytes-long-for-aes!!";

const baseConfig = {
  INTEGRATION_ENCRYPTION_KEY: ENC_KEY,
  GOOGLE_CLIENT_ID: "google-client-id",
  GOOGLE_CLIENT_SECRET: "google-client-secret",
  MICROSOFT_CLIENT_ID: "ms-client-id",
  MICROSOFT_CLIENT_SECRET: "ms-client-secret",
  API_PUBLIC_URL: "http://localhost:3001",
  FRONTEND_URL: "http://localhost:3000",
  CORS_ORIGIN: ["http://localhost:3000"],
} as unknown as Env;

// ---------------------------------------------------------------------------
// DB mock helpers
// ---------------------------------------------------------------------------

function insertChain(result: unknown[]) {
  const returning = vi.fn().mockResolvedValue(result);
  const onConflictDoUpdate = vi.fn().mockReturnValue({ returning });
  const values = vi.fn().mockReturnValue({ onConflictDoUpdate, returning });
  return { values, onConflictDoUpdate, returning };
}

function selectLimitChain(result: unknown[]) {
  const c = {} as Record<string, ReturnType<typeof vi.fn>>;
  c.from = vi.fn().mockReturnValue(c);
  c.where = vi.fn().mockReturnValue(c);
  c.limit = vi.fn().mockResolvedValue(result);
  return c;
}

function updateChain() {
  const where = vi.fn().mockResolvedValue([]);
  const set = vi.fn().mockReturnValue({ where });
  return { set, where };
}

// ---------------------------------------------------------------------------
// fetch mock helpers
// ---------------------------------------------------------------------------

function mockFetch(...responses: Array<{ ok: boolean; body: unknown; text?: string }>) {
  const mocks = responses.map(({ ok, body, text }) =>
    vi.fn().mockResolvedValue({
      ok,
      json: vi.fn().mockResolvedValue(body),
      text: vi.fn().mockResolvedValue(text ?? JSON.stringify(body)),
    })
  );
  let call = 0;
  vi.stubGlobal("fetch", vi.fn(() => mocks[call++]?.()));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// getGoogleConnectUrl
// ---------------------------------------------------------------------------

describe("getGoogleConnectUrl", () => {
  it("throws 503 when GOOGLE_CLIENT_ID is not configured", () => {
    const config = { ...baseConfig, GOOGLE_CLIENT_ID: undefined } as unknown as Env;
    expect(() => getGoogleConnectUrl("ws-1", config)).toThrow(HttpError);
  });

  it("returns a URL starting with Google auth endpoint", () => {
    const url = getGoogleConnectUrl("ws-1", baseConfig);
    expect(url).toContain("accounts.google.com/o/oauth2/v2/auth");
  });

  it("includes client_id in the URL", () => {
    const url = getGoogleConnectUrl("ws-1", baseConfig);
    expect(url).toContain("client_id=google-client-id");
  });

  it("includes gmail scope in the URL", () => {
    const url = getGoogleConnectUrl("ws-1", baseConfig);
    expect(decodeURIComponent(url)).toContain("https://mail.google.com/");
  });

  it("includes a signed state parameter", () => {
    const url = getGoogleConnectUrl("ws-1", baseConfig);
    const params = new URLSearchParams(url.split("?")[1]);
    const state = params.get("state");
    expect(state).toBeTruthy();
    // state is base64url.sig format
    expect(state).toContain(".");
  });

  it("sets access_type=offline and prompt=consent for refresh tokens", () => {
    const url = getGoogleConnectUrl("ws-1", baseConfig);
    expect(url).toContain("access_type=offline");
    expect(url).toContain("prompt=consent");
  });
});

// ---------------------------------------------------------------------------
// getMicrosoftConnectUrl
// ---------------------------------------------------------------------------

describe("getMicrosoftConnectUrl", () => {
  it("throws 503 when MICROSOFT_CLIENT_ID is not configured", () => {
    const config = { ...baseConfig, MICROSOFT_CLIENT_ID: undefined } as unknown as Env;
    expect(() => getMicrosoftConnectUrl("ws-1", config)).toThrow(HttpError);
  });

  it("returns a URL starting with Microsoft auth endpoint", () => {
    const url = getMicrosoftConnectUrl("ws-1", baseConfig);
    expect(url).toContain("login.microsoftonline.com");
  });

  it("includes SMTP.Send scope for Microsoft", () => {
    const url = getMicrosoftConnectUrl("ws-1", baseConfig);
    expect(decodeURIComponent(url)).toContain("SMTP.Send");
  });

  it("includes offline_access scope for refresh tokens", () => {
    const url = getMicrosoftConnectUrl("ws-1", baseConfig);
    expect(decodeURIComponent(url)).toContain("offline_access");
  });
});

// ---------------------------------------------------------------------------
// handleGoogleCallback
// ---------------------------------------------------------------------------

describe("handleGoogleCallback", () => {
  it("throws 503 when Google client credentials are not configured", async () => {
    const config = { ...baseConfig, GOOGLE_CLIENT_ID: undefined } as unknown as Env;
    const db = {} as any;
    await expect(handleGoogleCallback("code", "state", db, config)).rejects.toThrow(HttpError);
  });

  it("throws 400 when state is invalid or tampered", async () => {
    const db = {} as any;
    await expect(handleGoogleCallback("code", "bad.state", db, baseConfig)).rejects.toThrow(HttpError);
  });

  it("returns redirect URL on success (Google)", async () => {
    const state = signOAuthState({ workspaceId: "ws-1", provider: "google" }, ENC_KEY);

    const tokenPayload = {
      access_token: "goog-access-token",
      refresh_token: "goog-refresh-token",
      expires_in: 3600,
      scope: "https://mail.google.com/ email profile",
      token_type: "Bearer",
    };
    const userPayload = { email: "user@gmail.com", name: "Test User" };

    mockFetch(
      { ok: true, body: tokenPayload },
      { ok: true, body: userPayload },
    );

    const chain = insertChain([{ id: "inbox-1", emailAddress: "user@gmail.com" }]);
    const db = { insert: vi.fn().mockReturnValue(chain) } as any;

    const result = await handleGoogleCallback("auth-code", state, db, baseConfig);

    expect(result.workspaceId).toBe("ws-1");
    expect(result.redirectUrl).toContain("connected=google");
  });

  it("throws 502 when Google token exchange fails", async () => {
    const state = signOAuthState({ workspaceId: "ws-1", provider: "google" }, ENC_KEY);

    mockFetch({ ok: false, body: {}, text: "invalid_grant" });

    const db = {} as any;
    await expect(handleGoogleCallback("bad-code", state, db, baseConfig)).rejects.toThrow(HttpError);
  });

  it("throws 502 when Google userinfo fetch fails", async () => {
    const state = signOAuthState({ workspaceId: "ws-1", provider: "google" }, ENC_KEY);

    mockFetch(
      { ok: true, body: { access_token: "tok", expires_in: 3600, token_type: "Bearer" } },
      { ok: false, body: {} },
    );

    const db = {} as any;
    await expect(handleGoogleCallback("code", state, db, baseConfig)).rejects.toThrow(HttpError);
  });

  it("throws 502 when Google userinfo returns no email", async () => {
    const state = signOAuthState({ workspaceId: "ws-1", provider: "google" }, ENC_KEY);

    mockFetch(
      { ok: true, body: { access_token: "tok", expires_in: 3600, token_type: "Bearer" } },
      { ok: true, body: { name: "No Email" } },
    );

    const db = {} as any;
    await expect(handleGoogleCallback("code", state, db, baseConfig)).rejects.toThrow(HttpError);
  });

  it("stores inbox with pending_verification status", async () => {
    const state = signOAuthState({ workspaceId: "ws-1", provider: "google" }, ENC_KEY);

    mockFetch(
      { ok: true, body: { access_token: "tok", expires_in: 3600, token_type: "Bearer" } },
      { ok: true, body: { email: "user@gmail.com", name: "User" } },
    );

    const chain = insertChain([{ id: "inbox-1" }]);
    const db = { insert: vi.fn().mockReturnValue(chain) } as any;

    await handleGoogleCallback("code", state, db, baseConfig);

    const insertedValues = chain.values.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(insertedValues.status).toBe("pending_verification");
    expect(insertedValues.provider).toBe("google");
  });

  it("encrypts OAuth tokens before storing (does not store plaintext)", async () => {
    const state = signOAuthState({ workspaceId: "ws-1", provider: "google" }, ENC_KEY);

    mockFetch(
      { ok: true, body: { access_token: "plain-access-token", refresh_token: "plain-refresh-token", expires_in: 3600, token_type: "Bearer" } },
      { ok: true, body: { email: "u@gmail.com" } },
    );

    const chain = insertChain([{ id: "inbox-1" }]);
    const db = { insert: vi.fn().mockReturnValue(chain) } as any;

    await handleGoogleCallback("code", state, db, baseConfig);

    const values = chain.values.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(values.oauthAccessTokenEncrypted).not.toContain("plain-access-token");
    expect(values.oauthRefreshTokenEncrypted).not.toContain("plain-refresh-token");
  });
});

// ---------------------------------------------------------------------------
// handleMicrosoftCallback
// ---------------------------------------------------------------------------

describe("handleMicrosoftCallback", () => {
  it("throws 503 when Microsoft client credentials are not configured", async () => {
    const config = { ...baseConfig, MICROSOFT_CLIENT_ID: undefined } as unknown as Env;
    await expect(handleMicrosoftCallback("code", "state", {} as any, config)).rejects.toThrow(HttpError);
  });

  it("throws 400 when state is invalid", async () => {
    await expect(handleMicrosoftCallback("code", "tampered.state", {} as any, baseConfig)).rejects.toThrow(HttpError);
  });

  it("returns redirect URL on success (Microsoft)", async () => {
    const state = signOAuthState({ workspaceId: "ws-2", provider: "microsoft" }, ENC_KEY);

    mockFetch(
      { ok: true, body: { access_token: "ms-token", expires_in: 3600, token_type: "Bearer" } },
      { ok: true, body: { mail: "user@outlook.com", displayName: "Ms User" } },
    );

    const chain = insertChain([{ id: "inbox-ms" }]);
    const db = { insert: vi.fn().mockReturnValue(chain) } as any;

    const result = await handleMicrosoftCallback("code", state, db, baseConfig);

    expect(result.workspaceId).toBe("ws-2");
    expect(result.redirectUrl).toContain("connected=microsoft");
  });

  it("uses userPrincipalName as fallback email when mail field is absent", async () => {
    const state = signOAuthState({ workspaceId: "ws-2", provider: "microsoft" }, ENC_KEY);

    mockFetch(
      { ok: true, body: { access_token: "ms-token", expires_in: 3600, token_type: "Bearer" } },
      { ok: true, body: { userPrincipalName: "upn@company.com", displayName: "UPN User" } },
    );

    const chain = insertChain([{ id: "inbox-ms" }]);
    const db = { insert: vi.fn().mockReturnValue(chain) } as any;

    await handleMicrosoftCallback("code", state, db, baseConfig);

    const values = chain.values.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(values.emailAddress).toBe("upn@company.com");
  });

  it("throws 502 when Microsoft returns no email address", async () => {
    const state = signOAuthState({ workspaceId: "ws-2", provider: "microsoft" }, ENC_KEY);

    mockFetch(
      { ok: true, body: { access_token: "ms-token", expires_in: 3600, token_type: "Bearer" } },
      { ok: true, body: { displayName: "No Email" } },
    );

    await expect(handleMicrosoftCallback("code", state, {} as any, baseConfig)).rejects.toThrow(HttpError);
  });
});

// ---------------------------------------------------------------------------
// resolveAccessToken
// ---------------------------------------------------------------------------

describe("resolveAccessToken", () => {
  const encryptedToken = encryptSecret("live-access-token", ENC_KEY);
  const encryptedRefresh = encryptSecret("refresh-token", ENC_KEY);

  const futureExpiry = new Date(Date.now() + 30 * 60 * 1000); // 30 min from now — still valid

  function makeInbox(overrides: Partial<{
    provider: string;
    oauthAccessTokenEncrypted: string | null;
    oauthTokenExpiresAt: Date | null;
    oauthRefreshTokenEncrypted: string | null;
  }>) {
    return {
      id: "inbox-1",
      provider: "google",
      oauthAccessTokenEncrypted: encryptedToken,
      oauthTokenExpiresAt: futureExpiry,
      oauthRefreshTokenEncrypted: encryptedRefresh,
      ...overrides,
    } as any;
  }

  it("throws 503 when INTEGRATION_ENCRYPTION_KEY is not set", async () => {
    const config = { ...baseConfig, INTEGRATION_ENCRYPTION_KEY: undefined } as unknown as Env;
    const inbox = makeInbox({});
    await expect(resolveAccessToken(inbox, {} as any, config)).rejects.toThrow(HttpError);
  });

  it("throws 400 when inbox has no OAuth access token", async () => {
    const inbox = makeInbox({ oauthAccessTokenEncrypted: null });
    await expect(resolveAccessToken(inbox, {} as any, baseConfig)).rejects.toThrow(HttpError);
  });

  it("returns decrypted access token when token is still valid", async () => {
    const inbox = makeInbox({});
    const token = await resolveAccessToken(inbox, {} as any, baseConfig);
    expect(token).toBe("live-access-token");
  });

  it("calls Google refresh when token is expired", async () => {
    const pastExpiry = new Date(Date.now() - 1000); // already expired
    const inbox = makeInbox({ oauthTokenExpiresAt: pastExpiry });

    // refreshGoogleToken will SELECT then fetch then UPDATE
    const newTokenPayload = { access_token: "new-google-token", expires_in: 3600, token_type: "Bearer" };
    mockFetch({ ok: true, body: newTokenPayload });

    const selectC = selectLimitChain([{ ...inbox, oauthRefreshTokenEncrypted: encryptedRefresh }]);
    const updC = updateChain();
    const db = {
      select: vi.fn().mockReturnValue(selectC),
      update: vi.fn().mockReturnValue(updC),
    } as any;

    const token = await resolveAccessToken(inbox, db, baseConfig);
    expect(token).toBe("new-google-token");
  });

  it("calls Microsoft refresh when token is within 5 minutes of expiry", async () => {
    const nearExpiry = new Date(Date.now() + 2 * 60 * 1000); // 2 min — within 5 min threshold
    const inbox = makeInbox({ provider: "microsoft", oauthTokenExpiresAt: nearExpiry });

    const newTokenPayload = { access_token: "new-ms-token", expires_in: 3600, token_type: "Bearer" };
    mockFetch({ ok: true, body: newTokenPayload });

    const selectC = selectLimitChain([{ ...inbox, oauthRefreshTokenEncrypted: encryptedRefresh }]);
    const updC = updateChain();
    const db = {
      select: vi.fn().mockReturnValue(selectC),
      update: vi.fn().mockReturnValue(updC),
    } as any;

    const token = await resolveAccessToken(inbox, db, { ...baseConfig } as Env);
    expect(token).toBe("new-ms-token");
  });

  it("throws 400 when token is expired and no refresh token stored", async () => {
    const pastExpiry = new Date(Date.now() - 1000);
    const inbox = makeInbox({ oauthTokenExpiresAt: pastExpiry });

    const selectC = selectLimitChain([{ ...inbox, oauthRefreshTokenEncrypted: null }]);
    const db = { select: vi.fn().mockReturnValue(selectC) } as any;

    await expect(resolveAccessToken(inbox, db, baseConfig)).rejects.toThrow(HttpError);
  });
});
