import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../../..");
const cdk = readFileSync(path.join(root, "infra/lib/stacks/compute-stack.ts"), "utf8");
const caddy = readFileSync(path.join(root, "deploy/hetzner/swarm/Caddyfile"), "utf8");

// Every "/api/v1/..." path the ALB sends to the CRM service lives between the CRM service definition
// and the api JWKS rule. Caddy must send exactly those to `crm`, or they fall through to `api` and 404.
function crmPathsFromCdk() {
  const start = cdk.indexOf('const crmEcs = new SkoutEcsService(this, "CrmService"');
  const end = cdk.indexOf("if (apiEcs.targetGroup)", start);
  assert.ok(start > 0 && end > start, "could not locate the CRM routing block in compute-stack.ts");
  const block = cdk.slice(start, end);
  return [...new Set(block.match(/"\/api\/v1\/[^"]+"/g)?.map((s) => s.slice(1, -1)) ?? [])];
}

function crmMatcherPaths() {
  const line = caddy.split("\n").find((l) => l.trim().startsWith("@crm path"));
  assert.ok(line, "Caddyfile has no `@crm path` matcher");
  return line.trim().split(/\s+/).slice(2);
}

test("Caddy routes every CRM path the ALB routed to the crm service", () => {
  const expected = crmPathsFromCdk();
  assert.ok(expected.length >= 15, `expected many CRM paths from the CDK, found ${expected.length}`);
  const actual = new Set(crmMatcherPaths());
  const missing = expected.filter((p) => !actual.has(p));
  assert.deepEqual(missing, [], `Caddyfile @crm is missing: ${missing.join(", ")}`);
});

test("Caddy does not send api-owned paths to crm", () => {
  const actual = crmMatcherPaths();
  assert.ok(!actual.includes("/api/v1/dashboard/summary*"), "dashboard/summary belongs to the api service");
  assert.ok(!actual.includes("/api/*"));
});
