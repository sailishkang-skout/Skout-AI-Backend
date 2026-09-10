import { describe, expect, it } from "vitest";
import { googleEventEndIso, googleEventStartIso } from "./google-calendar-events.js";

describe("googleEventStartIso", () => {
  it("prefers dateTime when present", () => {
    expect(googleEventStartIso({ dateTime: "2026-08-18T10:00:00+05:30", date: "2026-08-18" })).toBe(
      "2026-08-18T10:00:00+05:30"
    );
  });

  it("uses noon for all-day dates so they stay on that civil day in any timezone", () => {
    expect(googleEventStartIso({ date: "2026-08-18" })).toBe("2026-08-18T12:00:00");
  });

  it("returns empty when Google omitted both", () => {
    expect(googleEventStartIso(undefined)).toBe("");
    expect(googleEventEndIso({})).toBe("");
  });
});
