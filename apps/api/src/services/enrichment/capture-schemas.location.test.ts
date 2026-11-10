import { describe, expect, it } from "vitest";
import { sanitizePersonCapture } from "./capture-schemas.js";

describe("sanitizePersonCapture locationName", () => {
  it.each(["Present", "Jan 2022 - Present", "3 yrs 2 mos"])("drops a date-like location: %s", (locationName) => {
    const { data, rejected } = sanitizePersonCapture({ fullName: "Jane Doe", locationName } as never);
    expect(data.locationName).toBeUndefined();
    expect(rejected).toContain("locationName");
  });

  it("keeps a real place", () => {
    const { data } = sanitizePersonCapture({ fullName: "Jane Doe", locationName: "Berlin, Germany" } as never);
    expect(data.locationName).toBe("Berlin, Germany");
  });
});
