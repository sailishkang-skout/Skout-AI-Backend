import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(readFileSync(resolve(__dirname, "../manifest.json"), "utf8"));

describe("chrome extension identity", () => {
  it("uses manifest v3", () => {
    expect(manifest.manifest_version).toBe(3);
  });

  it("registers background service worker", () => {
    expect(manifest.background?.service_worker).toBe("background.js");
  });

  it("does not ship dev ALB host permissions", () => {
    const hosts = manifest.host_permissions ?? [];
    expect(hosts.some((h) => h.includes("elb.amazonaws.com"))).toBe(false);
  });

  it("includes alarms permission for proactive auth refresh", () => {
    expect(manifest.permissions).toContain("alarms");
  });
});
