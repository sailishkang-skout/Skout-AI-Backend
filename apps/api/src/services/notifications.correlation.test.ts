import { describe, expect, it, vi } from "vitest";

const warn = vi.fn();
const error = vi.fn();
vi.mock("@skout/observability", () => ({
  createLogger: () => ({ warn, error, info: vi.fn(), debug: vi.fn() }),
  captureException: vi.fn(),
}));

const { retryNotificationDelivery } = await import("./notifications.service.js");

const CORRELATION = "0f8fbc2e-8c0a-4f6e-9b7a-2d1c3e4f5a6b";

/**
 * Provider calls carry the originating correlation id in their failure logs, so one id can be
 * followed from the API request through the event to the Slack/Teams/email attempt.
 */
describe("provider delivery logs carry the correlation id", () => {
  it.each(["slack", "teams", "email"])("%s attempt failures log correlationId", async (channel) => {
    warn.mockClear();
    error.mockClear();
    await retryNotificationDelivery(
      channel,
      { workspaceId: "ws-1", eventId: "evt-1", correlationId: CORRELATION, eventType: "LifecycleTransitioned" },
      async () => {
        throw new Error("provider down");
      },
      async () => {}
    );
    expect(warn).toHaveBeenCalled();
    for (const call of warn.mock.calls) {
      expect(call[1]).toMatchObject({ channel, correlationId: CORRELATION, eventId: "evt-1" });
    }
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining("exhausted"),
      expect.objectContaining({ correlationId: CORRELATION })
    );
  });
});
