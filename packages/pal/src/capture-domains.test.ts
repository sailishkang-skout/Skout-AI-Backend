import { describe, expect, it } from "vitest";
import { isSyntheticCaptureDomain, linkedinHandleFromUrl } from "./capture-domains.js";

describe("capture-domains", () => {
  it("detects LinkedIn extension placeholder domains", () => {
    expect(isSyntheticCaptureDomain("openchat.linkedin")).toBe(true);
    expect(isSyntheticCaptureDomain("linkedin-capture.local")).toBe(true);
    expect(isSyntheticCaptureDomain("openchat.com")).toBe(false);
  });

  it("extracts LinkedIn handles from profile URLs", () => {
    expect(linkedinHandleFromUrl("https://www.linkedin.com/in/jane-doe/")).toBe("jane-doe");
    expect(linkedinHandleFromUrl("https://linkedin.com/in/john-smith?trk=foo")).toBe("john-smith");
    expect(linkedinHandleFromUrl("https://example.com")).toBeUndefined();
  });
});
