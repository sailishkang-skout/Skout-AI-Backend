import { describe, expect, it } from "vitest";
import { toPersonSummary } from "./research.service.js";

const row = (snapshot: Record<string, unknown>, contact: { contactEmail?: string | null; contactPhone?: string | null } = {}) => ({
  prospectId: "p-1",
  snapshot,
  updatedAt: new Date("2026-11-01T00:00:00Z"),
  contactId: "c-1",
  contactTitle: null,
  contactLinkedinUrl: "https://www.linkedin.com/in/jane-doe/",
  employmentStatus: null,
  companyId: null,
  companyName: null,
  ...contact,
});

describe("toPersonSummary contact fields", () => {
  it("never shows a date like Present as the location and falls back to the current job", () => {
    expect(toPersonSummary(row({ fullName: "Jane", locationName: "Present" })).location).toBeNull();
    expect(toPersonSummary(row({ fullName: "Jane", locationName: "Present", currentCompanies: [{ name: "Acme", location: "Berlin, Germany" }] })).location).toBe("Berlin, Germany");
    expect(toPersonSummary(row({ fullName: "Jane", locationName: "London, UK" })).location).toBe("London, UK");
  });

  it("returns the contact's email, phone and public LinkedIn URL", () => {
    const person = toPersonSummary(row({ fullName: "Jane" }, { contactEmail: "jane@acme.example", contactPhone: "+49 30 1234567" }));
    expect(person).toMatchObject({ email: "jane@acme.example", phone: "+49 30 1234567", linkedinUrl: "https://www.linkedin.com/in/jane-doe/" });
  });
});
