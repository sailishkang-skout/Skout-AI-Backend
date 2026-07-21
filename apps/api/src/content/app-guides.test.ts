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
    expect(guides.some((g) => g.slug === "hubspot-crm")).toBe(true);
  });
});
