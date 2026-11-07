import { describe, expect, it } from "vitest";
import { readCollectionData } from "../api.js";

describe("API collection responses", () => {
  it("returns collection data from a valid Skout response", () => {
    const data = [{ id: "list-1", name: "Prospects" }];
    expect(readCollectionData({ workspaceId: "workspace-1", data, total: 1 }, "target lists")).toBe(data);
  });

  it("rejects malformed or unavailable collection payloads instead of treating them as empty", () => {
    for (const body of [null, {}, { data: null }, { items: [] }]) {
      expect(() => readCollectionData(body, "active sequences")).toThrow(
        "Skout returned an invalid active sequences response."
      );
    }
  });
});
