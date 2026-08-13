import { describe, expect, it } from "vitest";
import { selectAppGuides, appGuidesToPrompt } from "../content/app-guides.js";

describe("app-guides chat grounding", () => {
  it("picks import guide for import questions", () => {
    const guides = selectAppGuides({ userMessage: "How do I import a CSV?", limit: 3 });
    expect(guides.some((g) => g.slug === "import-prospects")).toBe(true);
  });

  it("picks billing guide from page path", () => {
    const guides = selectAppGuides({ page: "/settings/workspace", userMessage: "invoice", limit: 3 });
    expect(guides.some((g) => g.slug === "billing-invoices" || g.slug === "workspace")).toBe(true);
  });

  it("picks HubSpot CRM guide for connect questions", () => {
    const guides = selectAppGuides({ userMessage: "How to connect HubSpot?", limit: 3 });
    expect(guides.some((g) => g.slug === "hubspot-crm" || g.slug === "crm-hubspot")).toBe(true);
  });

  it("picks sequences guide for A/B experiment questions", () => {
    const guides = selectAppGuides({ userMessage: "How do I run a 50/50 A/B sequence experiment?", limit: 3 });
    expect(guides.some((g) => g.slug === "sequences-ai")).toBe(true);
  });

  it("picks calling guide from the calling settings page", () => {
    const guides = selectAppGuides({ page: "/settings/calling", userMessage: "dial", limit: 3 });
    expect(guides.some((g) => g.slug === "calling")).toBe(true);
  });
});
