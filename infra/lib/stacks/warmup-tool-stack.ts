import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as ecr from "aws-cdk-lib/aws-ecr";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import * as servicediscovery from "aws-cdk-lib/aws-servicediscovery";
import { Stack, StackProps, CfnOutput, Tags } from "aws-cdk-lib";
import { Construct } from "constructs";
import type { EnvironmentConfig } from "../config/environments.js";
import type { SkoutDatabase } from "../constructs/skout-database.js";
import type { SkoutRedis } from "../constructs/skout-redis.js";
import { SkoutEcsService } from "../constructs/skout-ecs-service.js";
import { SkoutWorkerService } from "../constructs/skout-worker-service.js";

export interface WarmupToolStackProps extends StackProps {
  readonly config: EnvironmentConfig;
  readonly vpc: ec2.IVpc;
  readonly cluster: ecs.ICluster;
  readonly namespace: servicediscovery.INamespace;
  readonly database: SkoutDatabase;
  readonly redis: SkoutRedis;
  readonly repository: ecr.IRepository;
  readonly apiService: ecs.FargateService;
  /** Public Skout API base URL used for OAuth redirect URIs (proxied). */
  readonly apiPublicUrl: string;
  readonly warmupToolSecret: secretsmanager.ISecret;
  /** Shared with API/calendar/inbox — Warm-Up reuses SkoutDev/google for Gmail OAuth. */
  readonly googleSecret: secretsmanager.ISecret;
  readonly imageTag?: string;
  /**
   * Deploys services with desiredCount 0 until `email_warmup` DB exists.
   * Sequence: deploy with bootstrap → scripts/ecs-run-warmup-tool-migrations.sh
   * → redeploy without bootstrap.
   */
  readonly bootstrapMode?: boolean;
}

const WORKER_NOOP_HEALTHCHECK = ["CMD-SHELL", "node -e \"process.exit(0)\""];

/**
 * Skout Email Warm-Up Tool — mailbox warmup, conversations, pools, partner
 * network, kill switches. Internal-only; CloudMap at
 * http://warmup-tool.<namespace>:3010. Not on nightly scale-to-zero.
 */
export class WarmupToolStack extends Stack {
  readonly apiService: ecs.FargateService;

  constructor(scope: Construct, id: string, props: WarmupToolStackProps) {
    super(scope, id, props);

    const {
      config,
      vpc,
      cluster,
      namespace,
      database,
      redis,
      repository,
      apiService,
      apiPublicUrl,
      warmupToolSecret,
      googleSecret,
      imageTag,
    } = props;
    const bootstrapMode = props.bootstrapMode ?? false;

    const nodeHttpHealthCheck = (port: number, path: string) =>
      `node -e "fetch('http://127.0.0.1:${port}${path}').then((r)=>process.exit(r.status<400?0:1)).catch(()=>process.exit(1))"`;

    const publicBase = apiPublicUrl.replace(/\/$/, "");
    const sharedEnvironment: Record<string, string> = {
      NODE_ENV: "production",
      DATABASE_HOST: database.instance.dbInstanceEndpointAddress,
      DATABASE_PORT: database.instance.dbInstanceEndpointPort,
      DATABASE_NAME: "email_warmup",
      DATABASE_USER: "skout",
      DATABASE_SSL: "true",
      REDIS_URL: `redis://${redis.endpoint}:6379`,
      SERVICE_NAME: "skout-email-warmup-service",
      LOG_LEVEL: "info",
      GOOGLE_REDIRECT_URI: `${publicBase}/api/v1/warmup-tool/oauth/google/callback`,
      WARMUP_OAUTH_GOOGLE_CALLBACK: `${publicBase}/api/v1/warmup-tool/oauth/google/callback`,
      MICROSOFT_REDIRECT_URI: `${publicBase}/api/v1/warmup-tool/oauth/microsoft/callback`,
      WARMUP_OAUTH_MICROSOFT_CALLBACK: `${publicBase}/api/v1/warmup-tool/oauth/microsoft/callback`,
    };

    // Microsoft OAuth JSON keys must exist in SkoutDev/warmup-tool before enabling.
    // Missing keys make Warm-Up ECS tasks fail secret hydration and roll back CDK.
    // Enable with: cdk deploy -c warmupMicrosoftOAuth=true
    const injectMicrosoftOAuthSecrets =
      this.node.tryGetContext("warmupMicrosoftOAuth") === "true";

    const dbPasswordSecret = ecs.Secret.fromSecretsManager(database.secret, "password");
    const sharedSecrets: Record<string, ecs.Secret> = {
      DATABASE_PASSWORD: dbPasswordSecret,
      ENCRYPTION_KEY: ecs.Secret.fromSecretsManager(warmupToolSecret, "ENCRYPTION_KEY"),
      API_KEY_PEPPER: ecs.Secret.fromSecretsManager(warmupToolSecret, "API_KEY_PEPPER"),
      PLATFORM_PROVISIONING_KEY: ecs.Secret.fromSecretsManager(
        warmupToolSecret,
        "PLATFORM_PROVISIONING_KEY"
      ),
      GOOGLE_CLIENT_ID: ecs.Secret.fromSecretsManager(googleSecret, "GOOGLE_CLIENT_ID"),
      GOOGLE_CLIENT_SECRET: ecs.Secret.fromSecretsManager(googleSecret, "GOOGLE_CLIENT_SECRET"),
      ...(injectMicrosoftOAuthSecrets
        ? {
            MICROSOFT_CLIENT_ID: ecs.Secret.fromSecretsManager(
              warmupToolSecret,
              "MICROSOFT_CLIENT_ID"
            ),
            MICROSOFT_CLIENT_SECRET: ecs.Secret.fromSecretsManager(
              warmupToolSecret,
              "MICROSOFT_CLIENT_SECRET"
            ),
          }
        : {}),
    };

    const warmupApi = new SkoutEcsService(this, "WarmupToolApiService", {
      vpc,
      cluster,
      repository,
      imageTag,
      serviceName: "warmup-tool-api",
      environmentName: config.name,
      containerPort: 3010,
      cpu: config.ecs.warmupToolApiCpu,
      memoryMiB: config.ecs.warmupToolApiMemoryMiB,
      desiredCount: bootstrapMode ? 0 : config.ecs.warmupToolApiDesiredCount,
      healthCheckPath: "/health",
      containerHealthCheckCommand: [nodeHttpHealthCheck(3010, "/health")],
      internalOnly: true,
      environment: {
        ...sharedEnvironment,
        PORT: "3010",
        HTTP_PORT: "3010",
        HTTP_HOST: "0.0.0.0",
      },
      secrets: sharedSecrets,
    });

    warmupApi.service.enableCloudMap({
      name: "warmup-tool",
      cloudMapNamespace: namespace,
    });

    warmupApi.securityGroup.connections.allowFrom(apiService, ec2.Port.tcp(3010));

    googleSecret.grantRead(warmupApi.taskDefinition.executionRole!);
    googleSecret.grantRead(warmupApi.taskDefinition.taskRole);
    warmupToolSecret.grantRead(warmupApi.taskDefinition.executionRole!);
    warmupToolSecret.grantRead(warmupApi.taskDefinition.taskRole);

    const workerDefs: Array<{ id: string; serviceName: string; command: string[] }> = [
      {
        id: "WarmupToolExecutionWorker",
        serviceName: "warmup-tool-worker",
        command: ["node", "dist/workers/execution-worker-process.js"],
      },
      {
        id: "WarmupToolInboundWorker",
        serviceName: "warmup-tool-inbound",
        command: ["node", "dist/workers/inbound-poller-process.js"],
      },
      {
        id: "WarmupToolClassificationWorker",
        serviceName: "warmup-tool-classification",
        command: ["node", "dist/workers/conversation-classification-process.js"],
      },
      {
        id: "WarmupToolPolicyWorker",
        serviceName: "warmup-tool-policy",
        command: ["node", "dist/workers/conversation-policy-process.js"],
      },
    ];

    const workerSecurityGroups: Array<[string, ec2.SecurityGroup]> = [
      ["Api", warmupApi.securityGroup],
    ];

    for (const def of workerDefs) {
      const worker = new SkoutWorkerService(this, def.id, {
        vpc,
        cluster,
        repository,
        imageTag,
        serviceName: def.serviceName,
        environmentName: config.name,
        cpu: config.ecs.warmupToolWorkerCpu,
        memoryMiB: config.ecs.warmupToolWorkerMemoryMiB,
        desiredCount: bootstrapMode ? 0 : config.ecs.warmupToolWorkerDesiredCount,
        command: def.command,
        environment: sharedEnvironment,
        secrets: sharedSecrets,
        healthCheckCommand: WORKER_NOOP_HEALTHCHECK,
      });
      googleSecret.grantRead(worker.taskDefinition.executionRole!);
      googleSecret.grantRead(worker.taskDefinition.taskRole);
      warmupToolSecret.grantRead(worker.taskDefinition.executionRole!);
      warmupToolSecret.grantRead(worker.taskDefinition.taskRole);
      workerSecurityGroups.push([def.serviceName, worker.securityGroup]);
    }

    this.apiService = warmupApi.service;

    for (const [name, sg] of workerSecurityGroups) {
      new ec2.CfnSecurityGroupIngress(this, `WarmupToolToDb${name.replace(/[^a-zA-Z0-9]/g, "")}`, {
        groupId: database.securityGroup.securityGroupId,
        ipProtocol: "tcp",
        fromPort: 5432,
        toPort: 5432,
        sourceSecurityGroupId: sg.securityGroupId,
      });

      new ec2.CfnSecurityGroupIngress(this, `WarmupToolToRedis${name.replace(/[^a-zA-Z0-9]/g, "")}`, {
        groupId: redis.securityGroup.securityGroupId,
        ipProtocol: "tcp",
        fromPort: 6379,
        toPort: 6379,
        sourceSecurityGroupId: sg.securityGroupId,
      });
    }

    new CfnOutput(this, "WarmupToolServiceDns", {
      value: `warmup-tool.${namespace.namespaceName}:3010`,
      exportName: `${config.stackPrefix}-WarmupToolServiceDns`,
    });

    Tags.of(this).add("skout:environment", config.name);
  }
}
