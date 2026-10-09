#!/usr/bin/env node
// Usage: node smoke.mjs https://stg.example.dev   (DOCKER_HOST must point at the manager for internal checks)
import { execFileSync } from "node:child_process";

const base = process.argv[2];
if (!base) {
  console.error("usage: smoke.mjs <public base url>");
  process.exit(2);
}

const results = [];
const check = async (name, fn) => {
  try {
    await fn();
    results.push([name, true]);
    console.log(`PASS ${name}`);
  } catch (err) {
    results.push([name, false]);
    console.log(`FAIL ${name}: ${err.message}`);
  }
};
const get = async (p, ok) => {
  const res = await fetch(base + p, { redirect: "manual" });
  if (!ok(res.status)) throw new Error(`${p} -> ${res.status}`);
  return res;
};
const sh = (args) => execFileSync("docker", args, { encoding: "utf8" });

await check("api health through tunnel+caddy", () => get("/api/v1/health", (s) => s === 200));
await check("crm health routed to crm", () => get("/api/v1/crm/health", (s) => s === 200));
await check("web serves /app", () => get("/app", (s) => s >= 200 && s < 400));
await check("jwks routed to api", async () => {
  const res = await get("/.well-known/jwks.json", (s) => s === 200);
  const body = await res.json();
  if (!Array.isArray(body.keys) || body.keys.length === 0) throw new Error("no keys in JWKS");
});

// Probe from a throwaway container on the stack's overlay network, so the check works wherever the api
// task happens to be scheduled (a plain `docker exec` only sees containers on the manager node).
const internal = (url) =>
  sh([
    "run", "--rm", "--network", "skout_skout", "node:20-alpine",
    "node", "-e", `fetch('${url}').then(r=>process.exit(r.status<400?0:1)).catch(()=>process.exit(1))`,
  ]);

await check("api -> ai over overlay DNS", () => internal("http://ai:8000/health"));
await check("api -> email-intel-api over overlay DNS", () => internal("http://email-intel-api:3001/liveness"));
await check("api -> warmup-tool-api over overlay DNS", () => internal("http://warmup-tool-api:3010/health"));
await check("api -> clickhouse over overlay DNS", () => internal("http://clickhouse:8123/ping"));

// Outbound workers (email-intel worker, warm-up workers) stay off in staging; the scraper orchestrator has its
// own switch. The deploy workflow passes the replica counts it asked for, so a deliberate change is checked
// against those numbers.
const expectedOutbound = process.env.EXPECT_OUTBOUND_REPLICAS || "0";
const expectedScraper = process.env.EXPECT_SCRAPER_REPLICAS || "0";
await check(`workers at expected replicas (outbound ${expectedOutbound}, scraper ${expectedScraper})`, () => {
  const out = sh(["service", "ls", "--format", "{{.Name}} {{.Replicas}}"]);
  const want = {
    "scraper-orchestrator": expectedScraper,
    "email-intel-worker": expectedOutbound,
    "warmup-tool-worker": expectedOutbound,
    "warmup-tool-inbound": expectedOutbound,
    "warmup-tool-classification": expectedOutbound,
    "warmup-tool-policy": expectedOutbound,
  };
  for (const [name, n] of Object.entries(want)) {
    const line = out.split("\n").find((l) => l.startsWith(`skout_${name} `));
    if (!line || !line.includes(` ${n}/${n}`)) throw new Error(`${name} not at ${n}/${n}: ${line}`);
  }
});

const failed = results.filter(([, ok]) => !ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
