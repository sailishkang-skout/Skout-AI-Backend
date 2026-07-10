#!/usr/bin/env node
import * as cdk from "aws-cdk-lib";
import { getEnvironment } from "../lib/config/environments.js";
import { NetworkStack } from "../lib/stacks/network-stack.js";
import { DataStack } from "../lib/stacks/data-stack.js";
import { RegistryStack } from "../lib/stacks/registry-stack.js";
import { ComputeStack } from "../lib/stacks/compute-stack.js";
import { WorkersStack } from "../lib/stacks/workers-stack.js";
import { ObservabilityStack } from "../lib/stacks/observability-stack.js";
import { LocalConfigStack } from "../lib/stacks/local-config-stack.js";

const app = new cdk.App();

const envName = app.node.tryGetContext("env") ?? "dev";
const config = getEnvironment(envName);
const imageTag = app.node.tryGetContext("imageTag") as string | undefined;
/** Corpus workers only — avoids retagging api/ai/web when deploying scrapers alone. */
const scraperImageTag =
  (app.node.tryGetContext("scraperImageTag") as string | undefined) ?? imageTag;
const skipWeb = app.node.tryGetContext("skipWeb") === "true";
// CloudFront is the default HTTPS edge for all environments (AWS account verified — R8.1).
// Fall back to -c httpsMode=apigateway if CloudFront is unavailable in a region or needs bypass.
const httpsMode =
  (app.node.tryGetContext("httpsMode") as "none" | "apigateway" | "cloudfront" | undefined) ??
  "cloudfront";

const stackEnv: cdk.Environment = {
  account: config.account ?? process.env.CDK_DEFAULT_ACCOUNT,
  region: config.region,
};

if (!config.deployToAws) {
  new LocalConfigStack(app, `${config.stackPrefix}-Config`, {
    env: stackEnv,
    config,
    description: "Skout AI local environment reference (no AWS resources)",
  });
} else {
  const network = new NetworkStack(app, `${config.stackPrefix}-Network`, {
    env: stackEnv,
    config,
    description: `Skout AI ${config.name} VPC`,
  });

  const data = new DataStack(app, `${config.stackPrefix}-Data`, {
    env: stackEnv,
    config,
    vpc: network.vpc,
    description: `Skout AI ${config.name} data layer (RDS, Redis, S3, secrets)`,
  });

  const registry = new RegistryStack(app, `${config.stackPrefix}-Registry`, {
    env: stackEnv,
    config,
    description: `Skout AI ${config.name} ECR + GitHub OIDC`,
  });

  const compute = new ComputeStack(app, `${config.stackPrefix}-Compute`, {
    env: stackEnv,
    config: skipWeb
      ? { ...config, ecs: { ...config.ecs, webDesiredCount: 0 } }
      : config,
    vpc: network.vpc,
    database: data.database,
    redis: data.redis,
    secrets: data.secrets,
    exportsBucket: data.storage.exportsBucket,
    scrapeBucket: data.storage.scrapeBucket,
    apiRepository: registry.apiRepository,
    crmRepository: registry.crmRepository,
    aiRepository: registry.aiRepository,
    webRepository: registry.webRepository,
    imageTag,
    httpsMode,
    description: `Skout AI ${config.name} ECS services (API, CRM, AI, Web)`,
  });

  const workers = new WorkersStack(app, `${config.stackPrefix}-Workers`, {
    env: stackEnv,
    config,
    vpc: network.vpc,
    cluster: compute.cluster,
    database: data.database,
    redis: data.redis,
    secrets: data.secrets,
    scrapeBucket: data.storage.scrapeBucket,
    orchestratorRepository: registry.scraperOrchestratorRepository,
    cleanerRepository: registry.scraperCleanerRepository,
    ingestorRepository: registry.scraperIngestorRepository,
    scraperImageTag,
    description: `Skout AI ${config.name} corpus workers (orchestrator, cleaner, ingestor)`,
  });
  workers.addDependency(compute);

  new ObservabilityStack(app, `${config.stackPrefix}-Observability`, {
    env: stackEnv,
    config,
    loadBalancer: compute.loadBalancer,
    apiService: compute.apiService,
    database: data.database.instance,
    apiLogGroupName: compute.apiLogGroupName,
    alertEmail: config.alertEmail,
    description: `Skout AI ${config.name} CloudWatch alarms`,
  });
}

app.synth();
