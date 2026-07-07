import { describe, expect, it, vi, beforeEach } from "vitest";

const sendMail = vi.fn();
const createTransport = vi.fn().mockReturnValue({ sendMail });

vi.mock("nodemailer", () => ({
  default: { createTransport: (...args: unknown[]) => createTransport(...args) },
}));

import { buildEmailSenderFromInbox, type InboxSmtpConfig } from "./email-sender.service.js";
import { encryptSecret } from "../utils/integration-crypto.js";
import type { Env } from "../config/env.js";

const ENCRYPTION_KEY = "test-encryption-key";
const config = { INTEGRATION_ENCRYPTION_KEY: ENCRYPTION_KEY } as unknown as Env;

function validInbox(overrides: Partial<InboxSmtpConfig> = {}): InboxSmtpConfig {
  return {
    smtpHost: "smtp.example.com",
    smtpPort: 587,
    smtpUsername: "user@example.com",
    smtpPasswordEncrypted: encryptSecret("super-secret-password", ENCRYPTION_KEY),
    smtpSecure: true,
    ...overrides,
  };
}

describe("buildEmailSenderFromInbox", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    createTransport.mockReturnValue({ sendMail });
  });

  it("throws when SMTP credentials are incomplete", () => {
    expect(() => buildEmailSenderFromInbox(config, validInbox({ smtpHost: null }))).toThrow(
      "inbox_missing_smtp_credentials"
    );
  });

  it("throws when INTEGRATION_ENCRYPTION_KEY is not configured", () => {
    expect(() =>
      buildEmailSenderFromInbox({ INTEGRATION_ENCRYPTION_KEY: undefined } as unknown as Env, validInbox())
    ).toThrow("INTEGRATION_ENCRYPTION_KEY");
  });

  it("creates a transport with decrypted credentials", () => {
    buildEmailSenderFromInbox(config, validInbox());
    expect(createTransport).toHaveBeenCalledWith(
      expect.objectContaining({
        host: "smtp.example.com",
        port: 587,
        secure: true,
        auth: { user: "user@example.com", pass: "super-secret-password" },
      })
    );
  });

  it("uses secure: false for port 587 (STARTTLS)", () => {
    buildEmailSenderFromInbox(config, validInbox({ smtpHost: "smtp.starttls-test.com", smtpPort: 587, smtpSecure: false }));
    expect(createTransport).toHaveBeenCalledWith(
      expect.objectContaining({ port: 587, secure: false })
    );
  });

  it("uses secure: true for port 465 (SMTPS)", () => {
    buildEmailSenderFromInbox(config, validInbox({ smtpHost: "smtp.smtps-test.com", smtpPort: 465, smtpSecure: true }));
    expect(createTransport).toHaveBeenCalledWith(
      expect.objectContaining({ port: 465, secure: true })
    );
  });

  it("sets connection, greeting, and socket timeouts on the transport", () => {
    // Use distinct credentials so this test bypasses the transporter cache
    buildEmailSenderFromInbox(config, validInbox({ smtpHost: "smtp.timeout-test.com" }));
    expect(createTransport).toHaveBeenCalledWith(
      expect.objectContaining({
        connectionTimeout: 10_000,
        greetingTimeout: 5_000,
        socketTimeout: 30_000,
      })
    );
  });

  it("sends mail with the from/fromName formatted and returns the messageId", async () => {
    sendMail.mockResolvedValue({ messageId: "msg-123" });
    const transport = buildEmailSenderFromInbox(config, validInbox());

    const result = await transport.send({
      from: "sender@example.com",
      fromName: "Sender Name",
      to: "recipient@example.com",
      subject: "Hello",
      text: "Hi there",
      html: "<p>Hi there</p>",
    });

    expect(sendMail).toHaveBeenCalledWith({
      from: '"Sender Name" <sender@example.com>',
      to: "recipient@example.com",
      subject: "Hello",
      text: "Hi there",
      html: "<p>Hi there</p>",
    });
    expect(result).toEqual({ externalId: "msg-123" });
  });

  it("sends mail with a bare from address when fromName is not set", async () => {
    sendMail.mockResolvedValue({ messageId: "msg-456" });
    const transport = buildEmailSenderFromInbox(config, validInbox());

    await transport.send({
      from: "sender@example.com",
      to: "recipient@example.com",
      subject: "Hello",
      text: "Hi",
      html: "<p>Hi</p>",
    });

    expect(sendMail).toHaveBeenCalledWith(expect.objectContaining({ from: "sender@example.com" }));
  });
});
