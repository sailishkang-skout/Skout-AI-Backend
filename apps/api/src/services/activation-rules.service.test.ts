import { describe, expect, it, vi } from "vitest";
import { matchActivationRules, reverseRuleRun } from "./activation-rules.service.js";
import type { Env } from "../config/env.js";

const config = {} as unknown as Env;

function selectChain(result: unknown[], terminal: "where" | "limit" | "groupBy" = "limit") {
  const c: Record<string, unknown> = {};
  c.from = vi.fn().mockReturnValue(c);
  c.leftJoin = vi.fn().mockReturnValue(c);
  c.where = terminal === "where" ? vi.fn().mockResolvedValue(result) : vi.fn().mockReturnValue(c);
  c.groupBy = terminal === "groupBy" ? vi.fn().mockResolvedValue(result) : vi.fn().mockReturnValue(c);
  c.limit = terminal === "limit" ? vi.fn().mockResolvedValue(result) : vi.fn().mockReturnValue(c);
  return c;
}

function updateReturning(result: unknown[]) {
  return { set: vi.fn().mockReturnValue({ where: vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue(result) }) }) };
}

function deleteReturning(result: unknown[]) {
  return { where: vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue(result) }) };
}

const RULE_ROW = (overrides: Partial<Record<string, unknown>> = {}) => ({
  id: "rule-1",
  workspaceId: "ws-1",
  name: "Hot leads",
  scoreThreshold: 80,
  signalType: null,
  targetAction: "enroll_sequence",
  targetId: "seq-1",
  enabled: true,
  createdBy: null,
  createdAt: new Date("2026-01-01T00:00:00Z"),
  updatedAt: new Date("2026-01-01T00:00:00Z"),
  ...overrides,
});

const RUN_ROW = (overrides: Partial<Record<string, unknown>> = {}) => ({
  id: "run-1",
  workspaceId: "ws-1",
  ruleId: "rule-1",
  prospectId: "prospect-1",
  actionTaken: "enroll_sequence",
  reversedAt: null,
  createdAt: new Date("2026-01-01T00:00:00Z"),
  ...overrides,
});

describe("matchActivationRules — R13.4 signal wiring", () => {
  it("does not match a signalType rule when the prospect has no active signals", async () => {
    const db = { select: vi.fn().mockReturnValue(selectChain([RULE_ROW({ signalType: "hiring" })], "where")) };
    const matches = await matchActivationRules(db as never, "ws-1", 90, []);
    expect(matches).toHaveLength(0);
  });

  it("matches a signalType rule once the signal is active", async () => {
    const db = { select: vi.fn().mockReturnValue(selectChain([RULE_ROW({ signalType: "hiring" })], "where")) };
    const matches = await matchActivationRules(db as never, "ws-1", 90, ["hiring", "funding"]);
    expect(matches).toHaveLength(1);
  });

  it("score-only rules are unaffected by signals either way", async () => {
    const db = { select: vi.fn().mockReturnValue(selectChain([RULE_ROW({ signalType: null })], "where")) };
    const matches = await matchActivationRules(db as never, "ws-1", 90, []);
    expect(matches).toHaveLength(1);
  });
});

describe("reverseRuleRun — R13.4 real reversal", () => {
  it("returns null when the run doesn't exist", async () => {
    const db = { select: vi.fn().mockReturnValue(selectChain([])) };
    const result = await reverseRuleRun(db as never, config, "ws-1", "missing-run");
    expect(result).toBeNull();
  });

  it("is idempotent — an already-reversed run reports undone:false without re-running the undo", async () => {
    const db = { select: vi.fn().mockReturnValue(selectChain([RUN_ROW({ reversedAt: new Date() })])) };
    const result = await reverseRuleRun(db as never, config, "ws-1", "run-1");
    expect(result).toEqual({ reversed: true, undone: false });
  });

  it("enroll_sequence: calls SequenceService.unenroll and marks undone:true", async () => {
    const db = {
      select: vi
        .fn()
        .mockReturnValueOnce(selectChain([RUN_ROW()]))
        .mockReturnValueOnce(selectChain([RULE_ROW({ targetAction: "enroll_sequence", targetId: "seq-1" })])),
      update: vi
        .fn()
        .mockReturnValueOnce(updateReturning([{ id: "enrollment-1" }])) // sequenceEnrollments update inside unenroll
        .mockReturnValueOnce(updateReturning([RUN_ROW({ reversedAt: new Date() })])), // activationRuleRuns update
    };
    const result = await reverseRuleRun(db as never, config, "ws-1", "run-1");
    expect(result).toEqual({ reversed: true, undone: true });
    expect(db.update).toHaveBeenCalledTimes(2);
  });

  it("add_to_list: calls ListService.removeMember and marks undone:true", async () => {
    const db = {
      select: vi
        .fn()
        .mockReturnValueOnce(selectChain([RUN_ROW()]))
        .mockReturnValueOnce(selectChain([RULE_ROW({ targetAction: "add_to_list", targetId: "list-1" })]))
        // ListService.removeMember -> getListById (select+groupBy)
        .mockReturnValueOnce(selectChain([{ id: "list-1", workspaceId: "ws-1", name: "L", createdAt: new Date(), memberCount: 1 }], "groupBy")),
      update: vi.fn().mockReturnValueOnce(updateReturning([RUN_ROW({ reversedAt: new Date() })])),
      delete: vi.fn().mockReturnValueOnce(deleteReturning([{ prospectId: "prospect-1" }])),
    };
    const result = await reverseRuleRun(db as never, config, "ws-1", "run-1");
    expect(result).toEqual({ reversed: true, undone: true });
    expect(db.delete).toHaveBeenCalledTimes(1);
  });

  it("activate: has no defined undo — reversed:true but undone:false", async () => {
    const db = {
      select: vi
        .fn()
        .mockReturnValueOnce(selectChain([RUN_ROW({ actionTaken: "activate" })]))
        .mockReturnValueOnce(selectChain([RULE_ROW({ targetAction: "activate", targetId: null })])),
      update: vi.fn().mockReturnValueOnce(updateReturning([RUN_ROW({ reversedAt: new Date() })])),
    };
    const result = await reverseRuleRun(db as never, config, "ws-1", "run-1");
    expect(result).toEqual({ reversed: true, undone: false });
  });
});
