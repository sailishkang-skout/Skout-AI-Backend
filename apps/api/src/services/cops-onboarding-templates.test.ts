import { describe, expect, it } from "vitest";
import { ONBOARDING_TEMPLATES, fillTemplateText, previewOnboardingTemplate } from "./cops-onboarding-templates.js";

const sample = { appBaseUrl: "https://app.example.test", resourcesUrl: "https://app.example.test/guides", supportEmail: "support@example.test" };

describe("onboarding email templates", () => {
  it("fills {{workspace}} and {{name}}", () => {
    expect(fillTemplateText("Hi {{name}}, {{ workspace }} is ready", { workspaceName: "Acme", customerName: "Priya" })).toBe("Hi Priya, Acme is ready");
    expect(fillTemplateText("Hi {{name}}", { workspaceName: "Acme" })).toBe("Hi there");
  });

  it("keeps the built-in wording when nothing is overridden", () => {
    const mail = previewOnboardingTemplate("welcome_paid", null, sample)!;
    expect(mail.subject).toBe("Welcome to Skout AI: Acme Corp");
    expect(mail.text).toContain('Welcome aboard. Your Skout AI workspace "Acme Corp" is ready.');
    expect(ONBOARDING_TEMPLATES.welcome_paid_enterprise!.defaults).toEqual(ONBOARDING_TEMPLATES.welcome_paid!.defaults);
  });

  it("previews the admin's wording with sample data, escaped in HTML", () => {
    const mail = previewOnboardingTemplate("welcome_trial", { subject: "{{name}}, your {{workspace}} trial is live", intro: "Start <here>", closing: "Cheers, team" }, sample)!;
    expect(mail.subject).toBe("Priya, your Acme Corp trial is live");
    expect(mail.html).toContain("Start &lt;here&gt;");
    expect(mail.html).toContain("Cheers, team");
    expect(mail.text).toContain("Your trial runs until");
  });

  it("returns null for an unknown template", () => {
    expect(previewOnboardingTemplate("nope", null, sample)).toBeNull();
  });
});
