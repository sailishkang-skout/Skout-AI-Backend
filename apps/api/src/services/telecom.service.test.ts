import { describe, expect, it } from "vitest";
import {
  activeTelecomProvider,
  isCallingConfigured,
  isSmsConfigured,
  telecomProviderLabel,
} from "./telecom.service.js";

const twilioOnly = {
  TWILIO_ENABLED: true,
  TWILIO_ACCOUNT_SID: "AC_test",
  TWILIO_AUTH_TOKEN: "token",
  TWILIO_PHONE_NUMBER: "+15005550006",
};

const telnyxOnly = {
  TWILIO_ENABLED: false,
  TELNYX_API_KEY: "KEY_test",
  TELNYX_PHONE_NUMBER: "+15005550006",
  TELNYX_CONNECTION_ID: "conn_123",
};

const telnyxSmsOnly = {
  TWILIO_ENABLED: false,
  TELNYX_API_KEY: "KEY_test",
  TELNYX_PHONE_NUMBER: "+15005550006",
};

const bothConfiguredTwilioOn = {
  TWILIO_ENABLED: true,
  TWILIO_ACCOUNT_SID: "AC_test",
  TWILIO_AUTH_TOKEN: "token",
  TWILIO_PHONE_NUMBER: "+15005550006",
  TELNYX_API_KEY: "KEY_test",
  TELNYX_PHONE_NUMBER: "+15005550006",
  TELNYX_CONNECTION_ID: "conn_123",
};

describe("activeTelecomProvider", () => {
  it("prefers Twilio when TWILIO_ENABLED is true and Twilio creds exist", () => {
    expect(activeTelecomProvider(bothConfiguredTwilioOn as never)).toBe("twilio");
    expect(telecomProviderLabel(bothConfiguredTwilioOn as never)).toBe("Twilio");
  });

  it("uses Telnyx when TWILIO_ENABLED is false even if Twilio creds exist", () => {
    expect(activeTelecomProvider({ ...bothConfiguredTwilioOn, TWILIO_ENABLED: false } as never)).toBe("telnyx");
  });

  it("uses Telnyx when Twilio is not enabled", () => {
    expect(activeTelecomProvider(telnyxOnly as never)).toBe("telnyx");
    expect(telecomProviderLabel(telnyxOnly as never)).toBe("Telnyx");
  });

  it("returns null when nothing is configured", () => {
    expect(activeTelecomProvider({ TWILIO_ENABLED: false } as never)).toBeNull();
    expect(isCallingConfigured({ TWILIO_ENABLED: false } as never)).toBe(false);
    expect(isSmsConfigured({ TWILIO_ENABLED: false } as never)).toBe(false);
  });

  it("treats Twilio as unavailable when TWILIO_ENABLED is true but creds are missing", () => {
    expect(activeTelecomProvider({ TWILIO_ENABLED: true } as never)).toBeNull();
  });

  it("supports SMS with Telnyx when only API key + phone are set", () => {
    expect(isSmsConfigured(telnyxSmsOnly as never)).toBe(true);
    expect(isCallingConfigured(telnyxSmsOnly as never)).toBe(false);
  });

  it("falls back to Telnyx when TWILIO_ENABLED is true but Twilio creds are incomplete", () => {
    expect(
      activeTelecomProvider({
        TWILIO_ENABLED: true,
        TWILIO_ACCOUNT_SID: "AC_test",
        TELNYX_API_KEY: "KEY_test",
        TELNYX_PHONE_NUMBER: "+15005550006",
        TELNYX_CONNECTION_ID: "conn_123",
      } as never)
    ).toBe("telnyx");
  });
});

describe("isCallingConfigured / isSmsConfigured", () => {
  it("is true for either provider", () => {
    expect(isCallingConfigured(twilioOnly as never)).toBe(true);
    expect(isSmsConfigured(twilioOnly as never)).toBe(true);
    expect(isCallingConfigured(telnyxOnly as never)).toBe(true);
    expect(isSmsConfigured(telnyxOnly as never)).toBe(true);
  });
});
