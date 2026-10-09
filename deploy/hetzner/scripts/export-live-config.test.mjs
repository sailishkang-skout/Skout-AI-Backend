import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseValueFrom,
  extractContainer,
  resolveSecrets,
  applyOverrides,
  toEnvFile,
  chunk,
  assertShimSupport,
} from "./export-live-config.mjs";

test("parseValueFrom strips the 6-char ARN suffix and returns the JSON key", () => {
  assert.deepEqual(
    parseValueFrom("arn:aws:secretsmanager:us-east-1:119408973331:secret:SkoutDev/clerk-AbC123:CLERK_SECRET_KEY::"),
    {
      secretName: "SkoutDev/clerk",
      secretId: "arn:aws:secretsmanager:us-east-1:119408973331:secret:SkoutDev/clerk-AbC123",
      key: "CLERK_SECRET_KEY",
    }
  );
  assert.deepEqual(
    parseValueFrom("arn:aws:secretsmanager:us-east-1:119408973331:secret:SkoutDev/scraper/proxy-Zz9Yx8:PROXY_URL::"),
    {
      secretName: "SkoutDev/scraper/proxy",
      secretId: "arn:aws:secretsmanager:us-east-1:119408973331:secret:SkoutDev/scraper/proxy-Zz9Yx8",
      key: "PROXY_URL",
    }
  );
});

test("parseValueFrom returns key null when the whole secret string is injected", () => {
  assert.deepEqual(
    parseValueFrom("arn:aws:secretsmanager:us-east-1:119408973331:secret:SkoutDev/openai-AbC123"),
    {
      secretName: "SkoutDev/openai",
      secretId: "arn:aws:secretsmanager:us-east-1:119408973331:secret:SkoutDev/openai-AbC123",
      key: null,
    }
  );
});

test("parseValueFrom rejects non Secrets Manager references", () => {
  assert.throws(() => parseValueFrom("arn:aws:ssm:us-east-1:1:parameter/x"), /Secrets Manager/);
});

test("extractContainer reads plaintext env and secret refs, ignoring the Datadog sidecar", () => {
  const taskDef = {
    containerDefinitions: [
      {
        name: "Container",
        command: ["node", "dist/worker.js"],
        environment: [{ name: "PORT", value: "3001" }],
        secrets: [
          {
            name: "CLERK_SECRET_KEY",
            valueFrom: "arn:aws:secretsmanager:us-east-1:1:secret:SkoutDev/clerk-AbC123:CLERK_SECRET_KEY::",
          },
        ],
      },
      { name: "DatadogAgent", environment: [{ name: "DD_SITE", value: "x" }] },
    ],
  };
  const out = extractContainer(taskDef);
  assert.deepEqual(out.env, { PORT: "3001" });
  assert.deepEqual(out.secrets, {
    CLERK_SECRET_KEY: {
      secretName: "SkoutDev/clerk",
      secretId: "arn:aws:secretsmanager:us-east-1:1:secret:SkoutDev/clerk-AbC123",
      key: "CLERK_SECRET_KEY",
    },
  });
  assert.deepEqual(out.command, ["node", "dist/worker.js"]);
});

test("extractContainer fails when the app container is missing", () => {
  assert.throws(() => extractContainer({ containerDefinitions: [{ name: "Other" }] }), /Container/);
});

test("resolveSecrets maps env names to values, supporting renamed keys and whole-string secrets", () => {
  const refs = {
    CLERK_SECRET_KEY: { secretName: "SkoutDev/clerk", key: "CLERK_SECRET_KEY" },
    NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: { secretName: "SkoutDev/clerk", key: "CLERK_PUBLISHABLE_KEY" },
    RAW: { secretName: "SkoutDev/raw", key: null },
  };
  const values = {
    "SkoutDev/clerk": { CLERK_SECRET_KEY: "sk", CLERK_PUBLISHABLE_KEY: "pk" },
    "SkoutDev/raw": "plain-value",
  };
  assert.deepEqual(resolveSecrets(refs, values), {
    CLERK_SECRET_KEY: "sk",
    NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: "pk",
    RAW: "plain-value",
  });
});

test("resolveSecrets fails loudly on a missing key or secret (no empty exports)", () => {
  const refs = { X: { secretName: "SkoutDev/a", key: "MISSING" } };
  assert.throws(() => resolveSecrets(refs, { "SkoutDev/a": { OTHER: "1" } }), /SkoutDev\/a.*MISSING/);
  assert.throws(() => resolveSecrets(refs, {}), /SkoutDev\/a/);
});

test("applyOverrides: static rewrites, then whenPresent sets, with ${VAR} templating", () => {
  const env = {
    API_PUBLIC_URL: "https://abc.execute-api.us-east-1.amazonaws.com",
    CLICKHOUSE_URL: "http://skout:skout@clickhouse.skoutdev.local:8123/skout",
    DATABASE_HOST: "old.rds.amazonaws.com",
    DATABASE_PORT: "5432",
  };
  const overrides = {
    rewrite: [["clickhouse.skoutdev.local", "clickhouse"]],
    whenPresent: {
      DATABASE_HOST: { DATABASE_HOST: "${PG_HOST}", DATABASE_PORT: "${PG_PORT}", DATABASE_SSL: "true" },
      REDIS_URL: { REDIS_URL: "redis://redis:6379" },
    },
  };
  const out = applyOverrides(
    env,
    overrides,
    { PG_HOST: "pg.db.ondigitalocean.com", PG_PORT: "25060" },
    [["https://abc.execute-api.us-east-1.amazonaws.com", "https://stg.example.dev"]]
  );
  assert.equal(out.API_PUBLIC_URL, "https://stg.example.dev");
  assert.equal(out.CLICKHOUSE_URL, "http://skout:skout@clickhouse:8123/skout");
  assert.equal(out.DATABASE_HOST, "pg.db.ondigitalocean.com");
  assert.equal(out.DATABASE_PORT, "25060");
  assert.equal(out.DATABASE_SSL, "true");
  assert.equal("REDIS_URL" in out, false, "whenPresent must not add keys the service never had");
});

test("applyOverrides: remove drops keys after the whenPresent sets have run", () => {
  const overrides = { whenPresent: { QUEUE_URL: { FLAG: "true" } }, remove: ["QUEUE_URL", "NOT_THERE"] };
  const out = applyOverrides({ QUEUE_URL: "https://sqs.example/q", KEEP: "1" }, overrides, {}, []);
  assert.deepEqual(out, { KEEP: "1", FLAG: "true" });
});

test("applyOverrides throws when a template variable is unset", () => {
  const overrides = { whenPresent: { A: { A: "${NOPE}" } } };
  assert.throws(() => applyOverrides({ A: "1" }, overrides, {}, []), /NOPE/);
});

test("toEnvFile writes KEY=value lines, sorted, and escapes multi-line values under KEY__NL", () => {
  const pem = "-----BEGIN PRIVATE KEY-----\nAAA\nBBB\n-----END PRIVATE KEY-----\n";
  const text = toEnvFile({ B: "2", A: "1", AUTH_JWT_PRIVATE_KEY: pem });
  assert.equal(
    text,
    "A=1\nAUTH_JWT_PRIVATE_KEY__NL=-----BEGIN PRIVATE KEY-----\\nAAA\\nBBB\\n-----END PRIVATE KEY-----\\n\nB=2\n"
  );
});

test("toEnvFile rejects carriage returns", () => {
  assert.throws(() => toEnvFile({ A: "x\ry" }), /carriage return/i);
});

test("parseValueFrom keeps the full ARN as the secret id so a name that merely looks suffixed is fetched correctly", () => {
  // A secret literally named "SkoutDev/clerk-issuer" referenced without an ARN suffix must not become "SkoutDev/clerk".
  const ref = parseValueFrom("arn:aws:secretsmanager:us-east-1:1:secret:SkoutDev/clerk-issuer:CLERK_JWT_ISSUER::");
  assert.equal(ref.secretId, "arn:aws:secretsmanager:us-east-1:1:secret:SkoutDev/clerk-issuer");
});

test("chunk splits a list into batches of at most n (ECS DescribeServices accepts 10 per call)", () => {
  const items = Array.from({ length: 14 }, (_, i) => i + 1);
  assert.deepEqual(chunk(items, 10), [items.slice(0, 10), items.slice(10)]);
  assert.deepEqual(chunk([], 10), []);
  assert.deepEqual(chunk([1, 2], 10), [[1, 2]]);
});

test("toEnvFile escapes existing backslashes in multi-line values so the shim restores them exactly", () => {
  // value: a literal backslash-n and backslash-c, then a REAL newline, then a second line
  const value = "has literal \\n and \\c\nsecond line";
  const out = toEnvFile({ K: value });
  // backslashes doubled, the real newline encoded as backslash-n
  assert.equal(out, "K__NL=has literal \\\\n and \\\\c\\nsecond line\n");
});

test("assertShimSupport allows multi-line values only for services whose entrypoint runs the shim", () => {
  assert.doesNotThrow(() => assertShimSupport("api", { PEM: "a\nb" }));
  assert.doesNotThrow(() => assertShimSupport("crm", { PLAIN: "single line" }));
  assert.throws(() => assertShimSupport("crm", { PEM: "a\nb" }), /crm.*PEM/);
});
