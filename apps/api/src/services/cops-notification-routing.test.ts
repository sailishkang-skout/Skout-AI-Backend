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

describe("COPS-08 approval notifications", () => {
  it("an approval request goes to the roles that have to decide; an Admin or owner gets the executive slot", () => {
    expect(resolveCopsNotificationRoles("ApprovalRequested", { required_approvers: ["sales_manager", "finance"] })).toEqual(["sales_manager", "finance"]);
    expect(resolveCopsNotificationRoles("ApprovalRequested", { required_approvers: ["executive", "legal_revops"] })).toEqual(["admin", "owner", "legal_revops"]);
    expect(resolveCopsNotificationRoles("ApprovalRequested", {})).toEqual([]);
  });

  it("the outcome goes to Sales and the Sales Manager, and a workspace route from config overrides both", () => {
    expect(resolveCopsNotificationRoles("ApprovalDecided", { status: "rejected" })).toEqual(["sales", "sales_manager"]);
    expect(resolveCopsNotificationRoles("ApprovalRequested", { required_approvers: ["finance"] }, ["admin"])).toEqual(["admin"]);
  });
});
