import { describe, expect, it } from "vitest";
import { previousRoleFromCaptures } from "./research.service.js";

const at = (iso: string) => new Date(iso);

describe("previousRoleFromCaptures", () => {
  const detectedAt = at("2026-11-01T00:00:00Z");

  it("uses a past role at a different company", () => {
    const from = previousRoleFromCaptures(
      [{ rawData: { previousCompanies: [{ name: "Uber", title: "Intern" }, { name: "Lyft", title: "Engineer" }] }, capturedAt: detectedAt }],
      "Uber",
      detectedAt
    );
    expect(from).toEqual({ company: "Lyft", title: "Engineer" });
  });

  it("falls back to the current role of a capture taken before the change", () => {
    const from = previousRoleFromCaptures(
      [
        { rawData: { currentCompanies: [{ name: "Uber", title: "Software Engineer" }] }, capturedAt: at("2026-11-05T00:00:00Z") },
        { rawData: { currentCompanies: [{ name: "Google", title: "SWE" }] }, capturedAt: at("2026-10-01T00:00:00Z") },
      ],
      "Uber",
      detectedAt
    );
    expect(from).toEqual({ company: "Google", title: "SWE" });
  });

  it("ignores current roles captured after the change", () => {
    const from = previousRoleFromCaptures(
      [{ rawData: { currentCompanies: [{ name: "Meta" }] }, capturedAt: at("2026-11-05T00:00:00Z") }],
      "Uber",
      detectedAt
    );
    expect(from).toBeNull();
  });
});
