import { afterEach, describe, expect, it, vi } from "vitest";
import { sendSms } from "./twilio.service.js";

const CONFIGURED = {
  TWILIO_ACCOUNT_SID: "AC_test_sid",
  TWILIO_AUTH_TOKEN: "test_token",
  TWILIO_PHONE_NUMBER: "+15005550006",
} as never;

const UNCONFIGURED = {
  TWILIO_ACCOUNT_SID: undefined,
  TWILIO_AUTH_TOKEN: undefined,
  TWILIO_PHONE_NUMBER: undefined,
} as never;

afterEach(() => {
  vi.restoreAllMocks();
});

describe("sendSms", () => {
  it("throws without hitting the network when Twilio isn't configured", async () => {
    const fetchSpy = vi.spyOn(global, "fetch");
    await expect(sendSms(UNCONFIGURED, { to: "+14155551234", body: "hi" })).rejects.toThrow(/not configured/i);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("posts to the Twilio Messages endpoint with Basic auth and form-encoded body", async () => {
    const fetchSpy = vi.spyOn(global, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ sid: "SM123", status: "queued" }), { status: 201 })
    );

    const result = await sendSms(CONFIGURED, { to: "+14155551234", body: "Your meeting starts soon" });

    expect(result).toEqual({ messageSid: "SM123", status: "queued" });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toBe("https://api.twilio.com/2010-04-01/Accounts/AC_test_sid/Messages.json");
    expect(init?.method).toBe("POST");
    const headers = init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Basic ${Buffer.from("AC_test_sid:test_token").toString("base64")}`);
    const body = new URLSearchParams(init?.body as string);
    expect(body.get("To")).toBe("+14155551234");
    expect(body.get("From")).toBe("+15005550006");
    expect(body.get("Body")).toBe("Your meeting starts soon");
  });

  it("throws with Twilio's error message when the API call fails", async () => {
    vi.spyOn(global, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ message: "The 'To' number is not a valid phone number." }), { status: 400 })
    );

    await expect(sendSms(CONFIGURED, { to: "not-a-number", body: "hi" })).rejects.toThrow(
      "The 'To' number is not a valid phone number."
    );
  });
});
