import { describe, expect, it, vi } from "vitest";
import { createWorkspaceToolRunner, requiresConfirmation, type ActionPreview } from "./ai-workspace-tools.service.js";
import type { Env } from "../config/env.js";

const CONFIG = {} as Env;

describe("requiresConfirmation", () => {
  const base: ActionPreview = {
    toolName: "x",
    scope: "does x",
    assumptions: [],
    affectedRecordCount: 1,
    creditCost: 0,
    externalSideEffects: [],
  };

  it("is false when affectedRecordCount<=1, creditCost=0, no side effects", () => {
    expect(requiresConfirmation(base)).toBe(false);
  });

  it("is true when affectedRecordCount > 1", () => {
    expect(requiresConfirmation({ ...base, affectedRecordCount: 2 })).toBe(true);
  });

  it("is true when creditCost > 0", () => {
    expect(requiresConfirmation({ ...base, creditCost: 1 })).toBe(true);
  });

  it("is true when externalSideEffects is non-empty", () => {
    expect(requiresConfirmation({ ...base, externalSideEffects: ["sends an email"] })).toBe(true);
  });
});

describe("createWorkspaceToolRunner — create_outbound_sequence preview gate", () => {
  it("returns a preview instead of executing when the sequence has more than one step and confirmed is not set", async () => {
    const runner = createWorkspaceToolRunner(null, CONFIG, "ws-1", false, "skout");
    const raw = await runner.run("create_outbound_sequence", {
      name: "Test Seq",
      steps: [
        { stepType: "email", delayDays: 0 },
        { stepType: "email", delayDays: 3 },
      ],
    });
    const parsed = JSON.parse(raw as string);
    expect(parsed.preview).toBeDefined();
    expect(parsed.preview.toolName).toBe("create_outbound_sequence");
    expect(parsed.preview.affectedRecordCount).toBe(2);
  });

  it("executes when confirmed is true, even with multiple steps", async () => {
    const runner = createWorkspaceToolRunner(null, CONFIG, "ws-1", false, "skout");
    const raw = await runner.run("create_outbound_sequence", {
      name: "Test Seq",
      steps: [
        { stepType: "email", delayDays: 0 },
        { stepType: "email", delayDays: 3 },
      ],
      confirmed: true,
    });
    const parsed = JSON.parse(raw as string);
    // db is null, so the real handler throws "database_unavailable" -- proves execution was
    // actually attempted (not gated), which is what this test checks for.
    expect(parsed.error).toBe("database_unavailable");
  });

  it("executes immediately for a single-step sequence with no confirmed flag (requiresConfirmation is false)", async () => {
    const runner = createWorkspaceToolRunner(null, CONFIG, "ws-1", false, "skout");
    const raw = await runner.run("create_outbound_sequence", {
      name: "Test Seq",
      steps: [{ stepType: "email", delayDays: 0 }],
    });
    const parsed = JSON.parse(raw as string);
    expect(parsed.preview).toBeUndefined();
    expect(parsed.error).toBe("database_unavailable");
  });
});
