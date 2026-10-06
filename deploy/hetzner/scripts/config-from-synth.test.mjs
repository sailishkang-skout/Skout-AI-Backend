import { test } from "node:test";
import assert from "node:assert/strict";
import {
  UNRESOLVED,
  flattenValue,
  buildSecretNameIndex,
  resolveSecretRef,
  extractServices,
  parseDotenv,
  fillSecrets,
  findUnresolved,
  unsetAfterOverrides,
} from "./config-from-synth.mjs";

test("unsetAfterOverrides keeps only secrets the overrides did not supply (e.g. the DB password from Terraform)", () => {
  assert.deepEqual(unsetAfterOverrides(["DATABASE_PASSWORD", "NOPE"], { DATABASE_PASSWORD: "p" }), ["NOPE"]);
  assert.deepEqual(unsetAfterOverrides([], {}), []);
});

// Minimal stand-ins for what `cdk synth` emits.
const dataTemplate = {
  Resources: {
    AppSecretsClerk3C7EB3C5: { Type: "AWS::SecretsManager::Secret", Properties: { Name: "SkoutDev/clerk" } },
    DatabaseDbSecret1098DC6E: { Type: "AWS::SecretsManager::Secret", Properties: { Name: "SkoutDev/database" } },
  },
  Outputs: {
    ExportsOutputRefAppSecretsClerk3C7EB3C545E9142A: {
      Value: { Ref: "AppSecretsClerk3C7EB3C5" },
      Export: { Name: "SkoutDev-Data:ExportsOutputRefAppSecretsClerk3C7EB3C545E9142A" },
    },
    ExportsOutputRefDatabaseDbSecret1098DC6E: {
      Value: { Ref: "DatabaseDbSecret1098DC6E" },
      Export: { Name: "SkoutDev-Data:ExportsOutputRefDatabaseDbSecret1098DC6E" },
    },
  },
};

test("buildSecretNameIndex maps cross-stack export names to secret names", () => {
  const index = buildSecretNameIndex(dataTemplate);
  assert.equal(index["SkoutDev-Data:ExportsOutputRefAppSecretsClerk3C7EB3C545E9142A"], "SkoutDev/clerk");
  assert.equal(index["SkoutDev-Data:ExportsOutputRefDatabaseDbSecret1098DC6E"], "SkoutDev/database");
});

test("resolveSecretRef handles an imported cross-stack secret", () => {
  const index = buildSecretNameIndex(dataTemplate);
  const valueFrom = {
    "Fn::Join": ["", [{ "Fn::ImportValue": "SkoutDev-Data:ExportsOutputRefAppSecretsClerk3C7EB3C545E9142A" }, ":CLERK_SECRET_KEY::"]],
  };
  assert.deepEqual(resolveSecretRef(valueFrom, index), { secretName: "SkoutDev/clerk", key: "CLERK_SECRET_KEY" });
});

test("resolveSecretRef handles a literal ARN and does NOT strip a name that merely looks suffixed", () => {
  const valueFrom = "arn:aws:secretsmanager:us-east-1:119408973331:secret:SkoutDev/clerk-issuer:CLERK_JWT_ISSUER::";
  assert.deepEqual(resolveSecretRef(valueFrom, {}), { secretName: "SkoutDev/clerk-issuer", key: "CLERK_JWT_ISSUER" });
});

test("resolveSecretRef handles an ARN assembled with the AWS::Partition pseudo parameter", () => {
  const valueFrom = {
    "Fn::Join": ["", ["arn:", { Ref: "AWS::Partition" }, ":secretsmanager:us-east-1:119408973331:secret:SkoutDev/smtp:SMTP_HOST::"]],
  };
  assert.deepEqual(resolveSecretRef(valueFrom, {}), { secretName: "SkoutDev/smtp", key: "SMTP_HOST" });
});

test("resolveSecretRef fails loudly on an export it cannot map (no silent wrong secret)", () => {
  const valueFrom = { "Fn::Join": ["", [{ "Fn::ImportValue": "SkoutDev-Data:Unknown" }, ":K::"]] };
  assert.throws(() => resolveSecretRef(valueFrom, {}), /Unknown/);
});

test("flattenValue resolves plain strings and joins, and marks AWS-derived tokens as unresolved", () => {
  assert.equal(flattenValue("3001"), "3001");
  assert.equal(flattenValue({ "Fn::Join": ["", ["https://www.skoutai.io", "/app"]] }), "https://www.skoutai.io/app");
  assert.equal(flattenValue({ "Fn::Join": ["", ["redis://", { "Fn::ImportValue": "x" }, ":6379"]] }), UNRESOLVED);
  assert.equal(flattenValue({ "Fn::GetAtt": ["Db", "Endpoint.Address"] }), UNRESOLVED);
});

test("extractServices reads each app container, keyed by its log stream prefix", () => {
  const index = buildSecretNameIndex(dataTemplate);
  const template = {
    Resources: {
      ApiTaskDef: {
        Type: "AWS::ECS::TaskDefinition",
        Properties: {
          ContainerDefinitions: [
            {
              Name: "Container",
              LogConfiguration: { Options: { "awslogs-stream-prefix": "api" } },
              Environment: [
                { Name: "PORT", Value: "3001" },
                { Name: "DATABASE_HOST", Value: { "Fn::ImportValue": "SkoutDev-Data:db" } },
              ],
              Secrets: [
                {
                  Name: "CLERK_SECRET_KEY",
                  ValueFrom: {
                    "Fn::Join": ["", [{ "Fn::ImportValue": "SkoutDev-Data:ExportsOutputRefAppSecretsClerk3C7EB3C545E9142A" }, ":CLERK_SECRET_KEY::"]],
                  },
                },
              ],
            },
            { Name: "DatadogAgent", Environment: [{ Name: "DD_SITE", Value: "x" }] },
          ],
        },
      },
      Other: { Type: "AWS::S3::Bucket", Properties: {} },
    },
  };
  const services = extractServices([template], index);
  assert.deepEqual(Object.keys(services), ["api"]);
  assert.deepEqual(services.api.env, { PORT: "3001", DATABASE_HOST: UNRESOLVED });
  assert.deepEqual(services.api.secrets, { CLERK_SECRET_KEY: { secretName: "SkoutDev/clerk", key: "CLERK_SECRET_KEY" } });
});

test("parseDotenv reads KEY=value lines, strips quotes, and ignores comments and blanks", () => {
  const text = "# comment\n\nA=1\nB=\"two words\"\nC='x'\nEMPTY=\nD=a=b\n";
  assert.deepEqual(parseDotenv(text), { A: "1", B: "two words", C: "x", EMPTY: "", D: "a=b" });
});

test("fillSecrets looks values up by env name, then JSON key, then secretName#key, and reports what is missing", () => {
  const refs = {
    CLERK_SECRET_KEY: { secretName: "SkoutDev/clerk", key: "CLERK_SECRET_KEY" },
    NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: { secretName: "SkoutDev/clerk", key: "CLERK_PUBLISHABLE_KEY" },
    ODD: { secretName: "SkoutDev/odd", key: "WEIRD" },
    NOPE: { secretName: "SkoutDev/nope", key: "NOPE_KEY" },
    BLANK: { secretName: "SkoutDev/blank", key: "BLANK" },
  };
  const values = {
    CLERK_SECRET_KEY: "sk",
    CLERK_PUBLISHABLE_KEY: "pk",
    "SkoutDev/odd#WEIRD": "odd-value",
    BLANK: "",
  };
  const { resolved, missing } = fillSecrets(refs, values);
  assert.deepEqual(resolved, {
    CLERK_SECRET_KEY: "sk",
    NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: "pk",
    ODD: "odd-value",
  });
  assert.deepEqual(missing.sort(), ["BLANK", "NOPE"]);
});

test("fillSecrets ignores the CDK placeholder value replace-me", () => {
  const refs = { A: { secretName: "SkoutDev/a", key: "A" } };
  const { resolved, missing } = fillSecrets(refs, { A: "replace-me" });
  assert.deepEqual(resolved, {});
  assert.deepEqual(missing, ["A"]);
});

test("findUnresolved lists variables still holding an AWS-derived placeholder after overrides", () => {
  assert.deepEqual(findUnresolved({ A: "ok", B: UNRESOLVED, C: "x" + UNRESOLVED }), ["B", "C"]);
  assert.deepEqual(findUnresolved({ A: "ok" }), []);
});
