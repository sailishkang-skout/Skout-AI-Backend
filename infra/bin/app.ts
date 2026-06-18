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
const skipWeb = app.node.tryGetContext("skipWeb") === "true";
const httpsMode =
  (app.node.tryGetContext("httpsMode") as "none" | "apigateway" | "cloudfront" | undefined) ??
  (envName === "dev" ? "apigateway" : "none");

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
    aiRepository: registry.aiRepository,
    webRepository: registry.webRepository,
    imageTag,
    httpsMode,
    description: `Skout AI ${config.name} ECS services (API, AI, Web)`,
  });

  new WorkersStack(app, `${config.stackPrefix}-Workers`, {
    env: stackEnv,
    config,
    vpc: network.vpc,
    scrapeBucket: data.storage.scrapeBucket,
    description: `Skout AI ${config.name} worker queues (scrape schedule)`,
  });

  new ObservabilityStack(app, `${config.stackPrefix}-Observability`, {
    env: stackEnv,
    config,
    loadBalancer: compute.loadBalancer,
    apiService: compute.apiService,
    database: data.database.instance,
    alertEmail: config.alertEmail,
    description: `Skout AI ${config.name} CloudWatch alarms`,
  });
}

app.synth();
