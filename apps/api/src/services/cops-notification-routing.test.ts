import { describe, expect, it } from "vitest";
import { defaultCopsNotificationRoles, resolveCopsNotificationRoles } from "./cops-notification-routing.js";

describe("COPS notification routing defaults", () => {
  it("routes onboarding and activation events to Customer Success", () => {
    expect(defaultCopsNotificationRoles("CustomerActivated")).toEqual(["cs"]);
    expect(defaultCopsNotificationRoles("WorkspaceProvisioned")).toEqual(["cs"]);
  });

  it("routes payment and credit events to Finance", () => {
    expect(defaultCopsNotificationRoles("PaymentSucceeded")).toEqual(["finance"]);
    expect(defaultCopsNotificationRoles("CreditsGranted")).toEqual(["finance"]);
  });

  it("routes engineering-ticket events to Engineering and Customer Success", () => {
    expect(defaultCopsNotificationRoles("TicketEscalated")).toEqual(["engineering", "cs"]);
  });

  it("selects lifecycle recipients by dimension", () => {
    expect(defaultCopsNotificationRoles("LifecycleTransitioned", { dimension: "commercial" })).toContain("finance");
  });

  it("lets a workspace override or intentionally disable the default roles", () => {
    expect(resolveCopsNotificationRoles("PaymentRequested", {}, ["cs", "cs"])).toEqual(["cs"]);
    expect(resolveCopsNotificationRoles("PaymentRequested", {}, [])).toEqual([]);
    expect(resolveCopsNotificationRoles("PaymentRequested", {}, ["not-a-cops-role"])).toEqual([]);
  });
});
