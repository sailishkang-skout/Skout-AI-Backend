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

  it("does not request broad optional host wildcards", () => {
    const optional = manifest.optional_host_permissions ?? [];
    expect(optional.some((h) => h === "http://*/*" || h === "https://*/*")).toBe(false);
  });

  it("includes production Skout web origins", () => {
    const hosts = manifest.host_permissions ?? [];
    expect(hosts).toContain("https://www.skoutai.io/*");
    expect(hosts).toContain("https://skoutai.io/*");
  });

  it("includes skout-web-bridge on production web origins", () => {
    const bridge = manifest.content_scripts?.find((cs) =>
      cs.js?.includes("skout-web-bridge.js")
    );
    expect(bridge?.matches).toContain("https://www.skoutai.io/*");
    expect(bridge?.matches).toContain("https://skoutai.io/*");
  });

  it("includes alarms permission for proactive auth refresh", () => {
    expect(manifest.permissions).toContain("alarms");
  });
});
