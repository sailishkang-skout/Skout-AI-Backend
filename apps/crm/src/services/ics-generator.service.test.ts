import { describe, expect, it } from "vitest";
import { generateMeetingIcs } from "./ics-generator.service.js";

describe("generateMeetingIcs", () => {
  it("generates a METHOD:REQUEST invite with the given UID and sequence", () => {
    const { icsContent } = generateMeetingIcs(
      {
        icsUid: "meeting-123@skout.ai",
        icsSequence: 0,
        title: "Intro call",
        scheduledAt: "2026-09-01T15:00:00.000Z",
        durationMinutes: 30,
        method: "REQUEST",
      },
      [{ email: "prospect@acme.com" }]
    );
    expect(icsContent).toContain("METHOD:REQUEST");
    expect(icsContent).toContain("UID:meeting-123@skout.ai");
    expect(icsContent).toContain("SEQUENCE:0");
    expect(icsContent).toContain("SUMMARY:Intro call");
    expect(icsContent).toContain("ATTENDEE");
    expect(icsContent).toContain("prospect@acme.com");
  });

  it("generates a METHOD:CANCEL invite with an incremented sequence", () => {
    const { icsContent } = generateMeetingIcs(
      {
        icsUid: "meeting-123@skout.ai",
        icsSequence: 2,
        title: "Intro call",
        scheduledAt: "2026-09-01T15:00:00.000Z",
        durationMinutes: 30,
        method: "CANCEL",
      },
      [{ email: "prospect@acme.com" }]
    );
    expect(icsContent).toContain("METHOD:CANCEL");
    expect(icsContent).toContain("SEQUENCE:2");
    expect(icsContent).toContain("STATUS:CANCELLED");
  });
});
