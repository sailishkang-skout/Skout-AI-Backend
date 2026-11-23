import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const manifest = JSON.parse(readFileSync(new URL("../manifest.json", import.meta.url), "utf8"));
const file = (path) => readFileSync(new URL(`../${path}`, import.meta.url));

describe("extension icons", () => {
  it("declares every Chrome icon size and each file is a PNG of exactly that size", () => {
    expect(Object.keys(manifest.icons).sort((a, b) => a - b)).toEqual(["16", "32", "48", "128"]);
    for (const [size, path] of Object.entries(manifest.icons)) {
      const png = file(path);
      expect(png.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
      expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([Number(size), Number(size)]);
      // RGBA, so the rounded corners are transparent rather than white.
      expect(png[25]).toBe(6);
    }
  });

  it("has no other icon references that point at a missing file", () => {
    const referenced = JSON.stringify(manifest).match(/icons\/[\w.-]+\.png/g) || [];
    for (const path of new Set(referenced)) expect(() => file(path)).not.toThrow();
  });
});
