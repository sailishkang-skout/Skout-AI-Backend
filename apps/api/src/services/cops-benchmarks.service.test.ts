import { describe, expect, it } from "vitest";
import { compare, MIN_PEERS } from "./cops-benchmarks.service.js";

describe("COPS-14 account benchmarks", () => {
  it("hides the comparison below the minimum number of peers", () => {
    const b = compare("health", "Health", 80, [70, 60, 50, 40], true);
    expect(MIN_PEERS).toBe(5);
    expect(b.peer_median).toBeNull();
    expect(b.better_than_pct).toBeNull();
    expect(b.peers).toBe(4);
  });
  it("gives the peer median and the share of peers beaten", () => {
    const b = compare("health", "Health", 80, [90, 70, 60, 50, 40], true);
    expect(b.peer_median).toBe(60);
    expect(b.better_than_pct).toBe(80);
  });
  it("treats lower as better when asked", () => {
    const b = compare("days", "Days", 5, [10, 12, 8, 3, 20], false);
    expect(b.better_than_pct).toBe(80);
  });
});
