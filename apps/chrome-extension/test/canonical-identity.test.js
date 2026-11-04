import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { canonicalLinkedinProspectId, linkedinProfileId } from "../identity.js";

describe("LinkedIn canonical prospect identity", () => {
  it("normalizes the public profile id", () => {
    expect(linkedinProfileId("https://www.linkedin.com/in/SahilSawAl/?trk=profile")).toBe("sahilsawal");
    expect(linkedinProfileId("https://example.com/in/sahilsawal/")).toBeUndefined();
    expect(linkedinProfileId("https://www.linkedin.com/in/sahil/other/")).toBeUndefined();
  });

  it("uses the same hash input as capture-ingest", async () => {
    const expected = createHash("sha256").update("linkedin:in:sahilsawal").digest("hex");
    await expect(
      canonicalLinkedinProspectId("https://www.linkedin.com/in/SahilSawAl/")
    ).resolves.toBe(expected);
  });

  it("returns no canonical id when there is no public profile URL", async () => {
    await expect(canonicalLinkedinProspectId(undefined)).resolves.toBeUndefined();
  });
});
