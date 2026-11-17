import { describe, expect, it } from "vitest";
import { subscriptionAccessBlock } from "./cops-subscription-access.js";

/** A db whose entitlement lookup returns `value`. */
const dbWith = (value: unknown) => {
  const chain: Record<string, unknown> = {};
  chain.select = () => chain;
  chain.from = () => chain;
  chain.where = () => chain;
  chain.limit = async () => (value === undefined ? [] : [{ value }]);
  return chain as never;
};

describe("trial access", () => {
  it("a trial is open until its end date, then suspended until a subscription starts", async () => {
    const future = new Date(Date.now() + 86_400_000).toISOString();
    const past = new Date(Date.now() - 1_000).toISOString();
    expect(await subscriptionAccessBlock(dbWith({ status: "trial", trial_ends_at: future }), "ws")).toBeNull();
    expect(await subscriptionAccessBlock(dbWith({ status: "trial", trial_ends_at: past }), "ws")).toBe("suspended");
  });

  it("a paid subscription and an internal workspace are not touched", async () => {
    expect(await subscriptionAccessBlock(dbWith({ status: "active" }), "ws")).toBeNull();
    expect(await subscriptionAccessBlock(dbWith(undefined), "ws")).toBeNull();
    expect(await subscriptionAccessBlock(dbWith({ status: "suspended" }), "ws")).toBe("suspended");
  });
});
