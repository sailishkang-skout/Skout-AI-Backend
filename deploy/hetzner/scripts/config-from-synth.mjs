#!/usr/bin/env node
// deploy/hetzner/scripts/config-from-synth.mjs
// Build the per-service env files WITHOUT touching AWS (AWS is shut off):
//   - which variables each service takes comes from `cdk synth` output (the same task definitions ECS ran),
//   - secret values come from local env/JSON files you supply plus generated secrets,
//   - AWS-derived values (DB host, redis, buckets, public URLs) are replaced by the overrides file,
//   - anything missing or still AWS-derived is reported, never silently exported.
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SERVICES, applyOverrides, assertShimSupport, toEnvFile } from "./export-live-config.mjs";

export const UNRESOLVED = "__AWS_DERIVED__";

const PSEUDO = { "AWS::Partition": "aws", "AWS::Region": "us-east-1", "AWS::URLSuffix": "amazonaws.com" };

/** Resolve a CloudFormation value to a string, or UNRESOLVED when it depends on AWS runtime tokens. */
export function flattenValue(value) {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value && typeof value === "object") {
    if ("Fn::Join" in value) {
      const [sep, parts] = value["Fn::Join"];
      const flat = parts.map(flattenValue);
      return flat.includes(UNRESOLVED) ? UNRESOLVED : flat.join(sep);
    }
    if ("Ref" in value && value.Ref in PSEUDO) return PSEUDO[value.Ref];
  }
  return UNRESOLVED;
}

/** Map cross-stack export names (Data stack outputs) to the Secrets Manager secret names they point at. */
export function buildSecretNameIndex(dataTemplate) {
  const index = {};
  for (const out of Object.values(dataTemplate.Outputs ?? {})) {
    const exportName = out.Export?.Name;
    const ref = out.Value?.Ref;
    const name = ref ? dataTemplate.Resources?.[ref]?.Properties?.Name : undefined;
    if (exportName && typeof name === "string") index[exportName] = name;
  }
  return index;
}

const ARN_PREFIX = "arn:aws:secretsmanager:us-east-1:0:secret:";

function flattenSecretFrom(value, index) {
  if (typeof value === "string") return value;
  if (value && typeof value === "object") {
    if ("Fn::Join" in value) {
      const [sep, parts] = value["Fn::Join"];
      return parts.map((p) => flattenSecretFrom(p, index)).join(sep);
    }
    if ("Fn::ImportValue" in value) {
      const name = index[value["Fn::ImportValue"]];
      if (!name) throw new Error(`Cannot map secret export ${value["Fn::ImportValue"]} to a secret name`);
      return ARN_PREFIX + name;
    }
    if ("Ref" in value && value.Ref in PSEUDO) return PSEUDO[value.Ref];
  }
  throw new Error(`Unsupported secret reference: ${JSON.stringify(value)}`);
}

/**
 * Resolve an ECS secret reference from a synthesized template to { secretName, key }.
 * Synth ARNs carry no random suffix, so names are used exactly as written.
 */
export function resolveSecretRef(valueFrom, index) {
  const text = flattenSecretFrom(valueFrom, index);
  const parts = text.split(":");
  if (parts[0] !== "arn" || parts[2] !== "secretsmanager") {
    throw new Error(`Not a Secrets Manager reference: ${text}`);
  }
  return { secretName: parts[6], key: parts[7] ? parts[7] : null };
}

/** Each app container ("Container") from synthesized templates, keyed by its log stream prefix (the service name). */
export function extractServices(templates, index) {
  const services = {};
  for (const template of templates) {
    for (const resource of Object.values(template.Resources ?? {})) {
      if (resource.Type !== "AWS::ECS::TaskDefinition") continue;
      for (const c of resource.Properties.ContainerDefinitions ?? []) {
        if (c.Name !== "Container") continue;
        const name = c.LogConfiguration?.Options?.["awslogs-stream-prefix"];
        if (typeof name !== "string") throw new Error("Task definition container has no awslogs-stream-prefix");
        const env = Object.fromEntries((c.Environment ?? []).map((e) => [e.Name, flattenValue(e.Value)]));
        const secrets = Object.fromEntries(
          (c.Secrets ?? []).map((s) => [s.Name, resolveSecretRef(s.ValueFrom, index)])
        );
        services[name] = { env, secrets };
      }
    }
  }
  return services;
}

export function parseDotenv(text) {
  const out = {};
  for (const raw of text.replace(/\r/g, "").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1, -1).replace(/\\n/g, "\n");
    } else if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

const usable = (v) => typeof v === "string" && v !== "" && v !== "replace-me" && !v.includes(UNRESOLVED);

/** Look each secret up by env name, then JSON key, then "secretName#key". Missing ones are reported. */
export function fillSecrets(refs, values) {
  const resolved = {};
  const missing = [];
  for (const [envName, { secretName, key }] of Object.entries(refs)) {
    const candidates = [values[envName], key ? values[key] : undefined, key ? values[`${secretName}#${key}`] : undefined];
    const found = candidates.find(usable);
    if (found === undefined) missing.push(envName);
    else resolved[envName] = found;
  }
  return { resolved, missing };
}

/** Secrets still absent after the overrides ran (the overrides supply e.g. DATABASE_PASSWORD from Terraform). */
export function unsetAfterOverrides(missing, finalEnv) {
  return missing.filter((name) => !(name in finalEnv));
}

export function findUnresolved(env) {
  return Object.keys(env).filter((k) => env[k].includes(UNRESOLVED));
}

function loadValues(file) {
  const text = readFileSync(file, "utf8");
  if (file.endsWith(".json")) return JSON.parse(text);
  return parseDotenv(text);
}

function main() {
  const args = process.argv.slice(2);
  const many = (name) => args.flatMap((a, i) => (a === `--${name}` ? [args[i + 1]] : []));
  const one = (name, def) => many(name)[0] ?? def;
  const synthDir = one("synth");
  if (!synthDir) throw new Error("--synth <cdk.out directory> is required");
  const outDir = one("out", "deploy/hetzner/env");
  const overrides = JSON.parse(readFileSync(one("overrides", "deploy/hetzner/overrides/staging.json"), "utf8"));
  const rewrites = many("rewrite").map((s) => s.split("=>"));
  const allowMissing = args.includes("--allow-missing");
  const values = Object.assign({}, ...many("values").map(loadValues));

  const templates = readdirSync(synthDir)
    .filter((f) => f.endsWith(".template.json"))
    .map((f) => ({ f, t: JSON.parse(readFileSync(path.join(synthDir, f), "utf8")) }));
  const dataTemplate = templates.find((x) => x.f.endsWith("-Data.template.json"))?.t;
  if (!dataTemplate) throw new Error("No *-Data.template.json in the synth directory");
  const services = extractServices(templates.map((x) => x.t), buildSecretNameIndex(dataTemplate));

  mkdirSync(outDir, { recursive: true });
  let problems = 0;
  for (const name of SERVICES) {
    const svc = services[name];
    if (!svc) throw new Error(`Service ${name} not found in the synthesized templates`);
    const { resolved, missing: missingBeforeOverrides } = fillSecrets(svc.secrets, values);
    const merged = { ...svc.env, ...resolved };
    const final = applyOverrides(merged, overrides, process.env, rewrites);
    const missing = unsetAfterOverrides(missingBeforeOverrides, final);
    const unresolved = findUnresolved(final);
    assertShimSupport(name, final);
    writeFileSync(path.join(outDir, `${name}.env`), toEnvFile(final), { mode: 0o600 });
    console.log(`wrote ${name}.env (${Object.keys(final).length} vars)`);
    if (missing.length) console.log(`  missing secrets (${missing.length}): ${missing.join(", ")}`);
    if (unresolved.length) console.log(`  STILL AWS-DERIVED (${unresolved.length}): ${unresolved.join(", ")}`);
    problems += unresolved.length + (allowMissing ? 0 : missing.length);
  }
  if (problems) {
    console.error(`\n${problems} problem(s). Supply the missing values with --values, add overrides for AWS-derived ones, or use --allow-missing for optional vendors.`);
    process.exit(1);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main();
}
