#!/usr/bin/env node
// deploy/hetzner/scripts/export-live-config.mjs
// Export the live ECS service configuration (plaintext env + resolved Secrets Manager values)
// into one env file per service, applying Hetzner overrides. READ-ONLY against AWS.
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const SERVICES = [
  "api", "crm", "ai", "web",
  "scraper-orchestrator", "scraper-cleaner", "scraper-ingestor",
  "email-intel-api", "email-intel-worker",
  "warmup-tool-api", "warmup-tool-worker", "warmup-tool-inbound",
  "warmup-tool-classification", "warmup-tool-policy",
];

export function parseValueFrom(valueFrom) {
  const parts = valueFrom.split(":");
  if (parts[0] !== "arn" || parts[2] !== "secretsmanager") {
    throw new Error(`Not a Secrets Manager reference: ${valueFrom}`);
  }
  const secretName = parts[6].replace(/-[A-Za-z0-9]{6}$/, "");
  // The ARN without the JSON-key/version fields identifies the secret unambiguously, even when a name
  // merely looks like it carries an ARN suffix (e.g. "SkoutDev/clerk-issuer").
  const secretId = parts.slice(0, 7).join(":");
  const key = parts[7] ? parts[7] : null;
  return { secretName, secretId, key };
}

export function chunk(items, size) {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

// Only these services start through /unescape-env.sh (see swarm/stack.yml); a multi-line value elsewhere
// would arrive as FOO__NL with no FOO.
const SHIM_SERVICES = new Set(["api"]);

export function assertShimSupport(service, env) {
  if (SHIM_SERVICES.has(service)) return;
  const multiline = Object.keys(env).filter((k) => env[k].includes("\n"));
  if (multiline.length) {
    throw new Error(
      `Service ${service} has multi-line value(s) ${multiline.join(", ")} but its entrypoint does not run unescape-env.sh`
    );
  }
}

export function extractContainer(taskDef, containerName = "Container") {
  const c = (taskDef.containerDefinitions ?? []).find((x) => x.name === containerName);
  if (!c) throw new Error(`Container "${containerName}" not found in task definition`);
  const env = Object.fromEntries((c.environment ?? []).map((e) => [e.name, e.value]));
  const secrets = Object.fromEntries(
    (c.secrets ?? []).map((s) => [s.name, parseValueFrom(s.valueFrom)])
  );
  return { env, secrets, command: c.command ?? null };
}

export function resolveSecrets(refs, secretValues) {
  const out = {};
  for (const [envName, { secretName, key }] of Object.entries(refs)) {
    if (!(secretName in secretValues)) {
      throw new Error(`Secret ${secretName} was not fetched (needed for ${envName})`);
    }
    const value = secretValues[secretName];
    if (key === null) {
      out[envName] = typeof value === "string" ? value : JSON.stringify(value);
      continue;
    }
    if (typeof value !== "object" || value === null || !(key in value)) {
      throw new Error(`Secret ${secretName} has no key ${key} (needed for ${envName})`);
    }
    out[envName] = String(value[key]);
  }
  return out;
}

function expand(value, processEnv) {
  return value.replace(/\$\{([A-Z0-9_]+)\}/g, (_, name) => {
    if (processEnv[name] === undefined) throw new Error(`Template variable ${name} is not set`);
    return processEnv[name];
  });
}

export function applyOverrides(env, overrides, processEnv, extraRewrites = []) {
  let out = { ...env };
  for (const [from, to] of [...(overrides.rewrite ?? []), ...extraRewrites]) {
    out = Object.fromEntries(Object.entries(out).map(([k, v]) => [k, v.split(from).join(to)]));
  }
  const base = { ...out };
  for (const [present, sets] of Object.entries(overrides.whenPresent ?? {})) {
    if (!(present in base)) continue;
    for (const [k, v] of Object.entries(sets)) out[k] = expand(v, processEnv);
  }
  return out;
}

export function toEnvFile(env) {
  const lines = Object.keys(env)
    .sort()
    .map((k) => {
      const v = env[k];
      if (v.includes("\r")) throw new Error(`${k} contains a carriage return`);
      // Escape existing backslashes first: the shim decodes with printf '%b', which would otherwise
      // turn a literal \n, \\ or \c inside the value into something else.
      if (v.includes("\n")) return `${k}__NL=${v.replace(/\\/g, "\\\\").replace(/\n/g, "\\n")}`;
      return `${k}=${v}`;
    });
  return lines.join("\n") + "\n";
}

function aws(args) {
  return execFileSync("aws", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

function main() {
  const args = process.argv.slice(2);
  const opt = (name, def) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 ? args[i + 1] : def;
  };
  const cluster = opt("cluster", "SkoutDev-cluster");
  const region = opt("region", "us-east-1");
  const outDir = opt("out", "deploy/hetzner/env");
  const overridesFile = opt("overrides", "deploy/hetzner/overrides/staging.json");
  const rewrites = args
    .map((a, i) => (a === "--rewrite" ? args[i + 1] : null))
    .filter(Boolean)
    .map((s) => s.split("=>"));
  const overrides = JSON.parse(readFileSync(overridesFile, "utf8"));
  mkdirSync(outDir, { recursive: true });

  // ECS DescribeServices accepts at most 10 services per call.
  const described = { services: [], failures: [] };
  for (const batch of chunk(SERVICES, 10)) {
    const part = JSON.parse(
      aws(["ecs", "describe-services", "--region", region, "--cluster", cluster, "--services", ...batch, "--output", "json"])
    );
    described.services.push(...(part.services ?? []));
    described.failures.push(...(part.failures ?? []));
  }
  if (described.failures.length) {
    throw new Error(`Services not found: ${JSON.stringify(described.failures)}`);
  }

  const secretCache = {};
  const fetchSecret = ({ secretName, secretId }) => {
    if (!(secretName in secretCache)) {
      const raw = aws(["secretsmanager", "get-secret-value", "--region", region, "--secret-id", secretId, "--query", "SecretString", "--output", "text"]).replace(/\n$/, "");
      try { secretCache[secretName] = JSON.parse(raw); } catch { secretCache[secretName] = raw; }
    }
  };

  for (const svc of described.services) {
    const taskDef = JSON.parse(
      aws(["ecs", "describe-task-definition", "--region", region, "--task-definition", svc.taskDefinition, "--query", "taskDefinition", "--output", "json"])
    );
    const { env, secrets } = extractContainer(taskDef);
    for (const ref of Object.values(secrets)) fetchSecret(ref);
    const merged = { ...env, ...resolveSecrets(secrets, secretCache) };
    const final = applyOverrides(merged, overrides, process.env, rewrites);
    assertShimSupport(svc.serviceName, final);
    const file = path.join(outDir, `${svc.serviceName}.env`);
    writeFileSync(file, toEnvFile(final), { mode: 0o600 });
    console.log(`wrote ${file} (${Object.keys(final).length} vars)`);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main();
}
