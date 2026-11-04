import { describe, expect, it } from "vitest";
import { conditionNodeHandler } from "./condition.node.js";
import type { NodeExecutionContext } from "./types.js";

function ctx(config: Record<string, unknown>, priorOutputs: Record<string, unknown> = {}): NodeExecutionContext {
  return {
    db: {} as any,
    config: {} as any,
    workspaceId: "ws-1",
    runId: "run-1",
    isSimulation: false,
    node: { id: "n1", type: "condition", config },
    priorOutputs,
  };
}

describe("conditionNodeHandler", () => {
  it("branches true when the field equals the expected value", async () => {
    const result = await conditionNodeHandler(
      ctx({ sourceNodeId: "n0", field: "status", op: "equals", value: "active" }, { n0: { status: "active" } })
    );
    expect(result.branch).toBe("true");
  });

  it("branches false when the field does not match", async () => {
    const result = await conditionNodeHandler(
      ctx({ sourceNodeId: "n0", field: "status", op: "equals", value: "active" }, { n0: { status: "paused" } })
    );
    expect(result.branch).toBe("false");
  });

  it("matches a numeric prior-output field against the config panel's string value", async () => {
    // The Value field in node-config-panel.tsx is a plain text input, so `value` here is always
    // a string — e.g. comparing action_http's real (non-simulation) numeric status code.
    const result = await conditionNodeHandler(
      ctx({ sourceNodeId: "n0", field: "status", op: "equals", value: "200" }, { n0: { status: 200 } })
    );
    expect(result.branch).toBe("true");
    expect(result.output).toMatchObject({ actual: 200, matches: true });
  });

  it("not_equals branches true when a numeric field differs from the string value", async () => {
    const result = await conditionNodeHandler(
      ctx({ sourceNodeId: "n0", field: "status", op: "not_equals", value: "200" }, { n0: { status: 500 } })
    );
    expect(result.branch).toBe("true");
  });

  it("treats a missing prior-output field as never matching a real value", async () => {
    const result = await conditionNodeHandler(
      ctx({ sourceNodeId: "n0", field: "missing", op: "equals", value: "200" }, { n0: { status: 200 } })
    );
    expect(result.branch).toBe("false");
  });
});

describe("conditionNodeHandler: COPS-10 groups and typed rules", () => {
  const prior = { t: { account: { tier: "enterprise", seats: "120", renewsAt: "2026-12-01", trial: "true", tags: "fintech, apac" } } };

  it("AND/OR groups with typed rules, and each rule's result on the step", async () => {
    const config = {
      match: "all",
      rules: [
        { sourceNodeId: "t", field: "account.seats", op: "gte", value: "100", type: "number" },
        {
          match: "any",
          rules: [
            { sourceNodeId: "t", field: "account.tier", op: "in", value: "growth, enterprise" },
            { sourceNodeId: "t", field: "account.trial", op: "equals", value: true, type: "boolean" },
          ],
        },
      ],
    };
    const result = await conditionNodeHandler(ctx(config, prior));
    expect(result.branch).toBe("true");
    const rules = result.output.rules as { field: string; matched: boolean }[];
    expect(rules.map((r) => [r.field, r.matched])).toEqual([
      ["account.seats", true],
      ["account.tier", true],
      ["account.trial", true],
    ]);
  });

  it("compares numbers as numbers and dates as dates, not as text", async () => {
    // As text "120" < "90"; as numbers it is not.
    expect((await conditionNodeHandler(ctx({ match: "all", rules: [{ sourceNodeId: "t", field: "account.seats", op: "lt", value: "90", type: "number" }] }, prior))).branch).toBe("false");
    expect((await conditionNodeHandler(ctx({ match: "all", rules: [{ sourceNodeId: "t", field: "account.renewsAt", op: "lt", value: "2027-01-01", type: "date" }] }, prior))).branch).toBe("true");
  });

  it("an unreadable value never matches a comparison, and exists checks presence", async () => {
    expect((await conditionNodeHandler(ctx({ match: "all", rules: [{ sourceNodeId: "t", field: "account.tier", op: "gt", value: "5", type: "number" }] }, prior))).branch).toBe("false");
    expect((await conditionNodeHandler(ctx({ match: "any", rules: [{ sourceNodeId: "t", field: "account.owner", op: "exists" }] }, prior))).branch).toBe("false");
    expect((await conditionNodeHandler(ctx({ match: "all", rules: [{ sourceNodeId: "t", field: "account.tags", op: "contains", value: "APAC" }] }, prior))).branch).toBe("true");
  });
});
