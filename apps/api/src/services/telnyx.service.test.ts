import { afterEach, describe, expect, it, vi } from "vitest";
import { sendSms } from "./telnyx.service.js";

const CONFIGURED = {
  TELNYX_API_KEY: "KEY_test",
  TELNYX_PHONE_NUMBER: "+15005550006",
  TELNYX_CONNECTION_ID: "conn_123",
  TELECOM_WEBHOOK_BASE_URL: "https://api.example.com",
} as never;

const UNCONFIGURED = {
  TELNYX_API_KEY: undefined,
  TELNYX_PHONE_NUMBER: undefined,
  TELNYX_CONNECTION_ID: undefined,
} as never;

afterEach(() => {
  vi.restoreAllMocks();
});

describe("sendSms", () => {
  it("throws without hitting the network when Telnyx isn't configured", async () => {
    const fetchSpy = vi.spyOn(global, "fetch");
    await expect(sendSms(UNCONFIGURED, { to: "+14155551234", body: "hi" })).rejects.toThrow(/not configured/i);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("posts to the Telnyx Messages endpoint with Bearer auth and JSON body", async () => {
    const fetchSpy = vi.spyOn(global, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ data: { id: "msg_123", status: "queued" } }), { status: 200 })
    );

    const result = await sendSms(CONFIGURED, { to: "+14155551234", body: "Your meeting starts soon" });

    expect(result).toEqual({ messageSid: "msg_123", status: "queued" });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toBe("https://api.telnyx.com/v2/messages");
    expect(init?.method).toBe("POST");
    const headers = init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer KEY_test");
    expect(JSON.parse(init?.body as string)).toEqual({
      from: "+15005550006",
      to: "+14155551234",
      text: "Your meeting starts soon",
    });
  });

  it("throws with Telnyx error detail when the API call fails", async () => {
    vi.spyOn(global, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ errors: [{ detail: "Invalid 'to' address" }] }), { status: 422 })
    );

    await expect(sendSms(CONFIGURED, { to: "not-a-number", body: "hi" })).rejects.toThrow("Invalid 'to' address");
  });
});

describe("dialBridgeCall", () => {
  it("posts to the TeXML calls endpoint with webhook URLs", async () => {
    const { dialBridgeCall } = await import("./telnyx.service.js");
    const fetchSpy = vi.spyOn(global, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ data: { call_sid: "call_abc", status: "queued" } }), { status: 200 })
    );

    const result = await dialBridgeCall(CONFIGURED, {
      agentPhone: "+14155550001",
      prospectPhone: "+14155550002",
      callbackParams: { workspaceId: "ws-1", userId: "user-1" },
    });

    expect(result).toEqual({ callSid: "call_abc", status: "queued" });
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toBe("https://api.telnyx.com/v2/texml/calls/conn_123");
    const body = new URLSearchParams(init?.body as string);
    expect(body.get("To")).toBe("+14155550001");
    expect(body.get("From")).toBe("+15005550006");
    expect(body.get("Url")).toContain("/api/v1/calls/twiml/bridge");
    expect(body.get("StatusCallback")).toContain("/api/v1/calls/status");
  });

  it("uses the workspace-assigned fromNumber when provided", async () => {
    const { dialBridgeCall } = await import("./telnyx.service.js");
    const fetchSpy = vi.spyOn(global, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ data: { call_sid: "call_xyz", status: "queued" } }), { status: 200 })
    );

    await dialBridgeCall(CONFIGURED, {
      agentPhone: "+14155550001",
      prospectPhone: "+14155550002",
      fromNumber: "+14155559999",
      callbackParams: { workspaceId: "ws-1" },
    });

    const body = new URLSearchParams(fetchSpy.mock.calls[0]![1]?.body as string);
    expect(body.get("From")).toBe("+14155559999");
  });
});
