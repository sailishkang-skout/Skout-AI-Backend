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

  it("keeps local development API hosts optional and scopes the required API host", () => {
    const hosts = manifest.host_permissions ?? [];
    const optional = manifest.optional_host_permissions ?? [];
    expect(hosts).toContain("https://ckoy6iywm0.execute-api.us-east-1.amazonaws.com/*");
    expect(hosts.some((h) => h.includes("localhost") || h.includes("127.0.0.1"))).toBe(false);
    expect(hosts.some((h) => h.includes("*.execute-api"))).toBe(false);
    expect(optional).toContain("http://localhost:4000/*");
    expect(optional).toContain("http://127.0.0.1:4000/*");
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
    expect(bridge?.matches?.some((h) => h.includes("execute-api"))).toBe(false);
    expect(manifest.externally_connectable?.matches?.some((h) => h.includes("execute-api"))).toBe(false);
  });

  it("includes alarms permission for proactive auth refresh", () => {
    expect(manifest.permissions).toContain("alarms");
  });
});
