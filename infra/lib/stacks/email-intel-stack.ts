import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as ecr from "aws-cdk-lib/aws-ecr";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as servicediscovery from "aws-cdk-lib/aws-servicediscovery";
import { Stack, StackProps, CfnOutput, Tags } from "aws-cdk-lib";
import { Construct } from "constructs";
import type { EnvironmentConfig } from "../config/environments.js";
import type { SkoutDatabase } from "../constructs/skout-database.js";
import type { SkoutRedis } from "../constructs/skout-redis.js";
import type { SkoutAppSecrets } from "../constructs/skout-app-secrets.js";
import { SkoutEcsService } from "../constructs/skout-ecs-service.js";
import { SkoutWorkerService } from "../constructs/skout-worker-service.js";

export interface EmailIntelStackProps extends StackProps {
  readonly config: EnvironmentConfig;
  readonly vpc: ec2.IVpc;
  readonly cluster: ecs.ICluster;
  readonly namespace: servicediscovery.INamespace;
  readonly database: SkoutDatabase;
  readonly redis: SkoutRedis;
  readonly bucket: s3.IBucket;
  readonly repository: ecr.IRepository;
  readonly apiService: ecs.FargateService;
  /** Shared secret for canonical evidence forwarder (§5.3). */
  readonly secrets: SkoutAppSecrets;
  readonly imageTag?: string;
  /**
   * Deploys both services with desiredCount 0 regardless of config, so ECS
   * never launches a task and the deployment circuit breaker can't trip.
   *
   * Needed on a fresh environment (or a fresh RDS instance) because both
   * server.ts and worker.ts run `runMigrations()` unconditionally at
   * startup, which requires the "email_intelligence" database to already
   * exist — but on the shared RDS instance used here, only the default
   * "skout" database is auto-created (see skout-database.ts). Bootstrap
   * sequence: deploy with this flag set (0 tasks, nothing to crash) → run
   * scripts/ecs-run-email-intel-migrations.sh (creates the database via a
   * one-off task against the now-existing task definition, then migrates)
   * → redeploy without this flag to bring the services up for real.
   * A one-time step per environment; once the database exists it persists
   * across all future redeploys.
   */
  readonly bootstrapMode?: boolean;
}

const WORKER_HEALTHCHECK = [
  "node",
  "-e",
  "const fs=require('fs');try{const s=fs.statSync('/tmp/worker-health/ready');process.exit((Date.now()-s.mtimeMs)<20000?0:1)}catch(e){process.exit(1)}",
];

/**
 * Email Intelligence Tool — SMTP-based email verification, pattern discovery/ranking,
 * and outbound send-eligibility checks. Internal-only (no public ALB route); reachable
 * from other ECS services via CloudMap at http://email-intel.<namespace>:3001.
 */
export class EmailIntelStack extends Stack {
  readonly apiService: ecs.FargateService;
  readonly workerService: ecs.FargateService;

  constructor(scope: Construct, id: string, props: EmailIntelStackProps) {
    super(scope, id, props);

    const { config, vpc, cluster, namespace, database, redis, bucket, repository, apiService, secrets, imageTag } =
      props;
    const bootstrapMode = props.bootstrapMode ?? false;

    const nodeHttpHealthCheck = (port: number, path: string) =>
      `node -e "fetch('http://127.0.0.1:${port}${path}').then((r)=>process.exit(r.status<400?0:1)).catch(()=>process.exit(1))"`;

    const sharedEnvironment = {
      NODE_ENV: "production",
      DATABASE_HOST: database.instance.dbInstanceEndpointAddress,
      DATABASE_PORT: database.instance.dbInstanceEndpointPort,
      DATABASE_NAME: "email_intelligence",
      DATABASE_USER: "skout",
      DATABASE_SSL: "true",
      REDIS_URL: `redis://${redis.endpoint}:6379`,
      STORAGE_BUCKET: bucket.bucketName,
      STORAGE_REGION: config.region,
      STORAGE_FORCE_PATH_STYLE: "false",
      OTEL_SERVICE_NAME: "email-intelligence-service",
    };

    const dbPasswordSecret = ecs.Secret.fromSecretsManager(database.secret, "password");
    const forwarderSecrets = {
      SKOUT_CANONICAL_EVIDENCE_URL: ecs.Secret.fromSecretsManager(
        secrets.emailIntelForwarder,
        "SKOUT_CANONICAL_EVIDENCE_URL"
      ),
      SKOUT_CANONICAL_EVIDENCE_TOKEN: ecs.Secret.fromSecretsManager(
        secrets.emailIntelForwarder,
        "SKOUT_CANONICAL_EVIDENCE_TOKEN"
      ),
    };

    const emailIntelApi = new SkoutEcsService(this, "EmailIntelApiService", {
      vpc,
      cluster,
      repository,
      imageTag,
      serviceName: "email-intel-api",
      environmentName: config.name,
      containerPort: 3001,
      cpu: config.ecs.emailIntelApiCpu,
      memoryMiB: config.ecs.emailIntelApiMemoryMiB,
      desiredCount: bootstrapMode ? 0 : config.ecs.emailIntelApiDesiredCount,
      healthCheckPath: "/liveness",
      containerHealthCheckCommand: [nodeHttpHealthCheck(3001, "/liveness")],
      internalOnly: true,
      environment: {
        ...sharedEnvironment,
        PORT: "3001",
        HOST: "0.0.0.0",
      },
      secrets: {
        DATABASE_PASSWORD: dbPasswordSecret,
        ...forwarderSecrets,
      },
    });

    emailIntelApi.service.enableCloudMap({
      name: "email-intel",
      cloudMapNamespace: namespace,
    });

    emailIntelApi.securityGroup.connections.allowFrom(apiService, ec2.Port.tcp(3001));

    const emailIntelWorker = new SkoutWorkerService(this, "EmailIntelWorkerService", {
      vpc,
      cluster,
      repository,
      imageTag,
      serviceName: "email-intel-worker",
      environmentName: config.name,
      cpu: config.ecs.emailIntelWorkerCpu,
      memoryMiB: config.ecs.emailIntelWorkerMemoryMiB,
      desiredCount: bootstrapMode ? 0 : config.ecs.emailIntelWorkerDesiredCount,
      command: ["node", "dist/worker.js"],
      environment: sharedEnvironment,
      secrets: {
        DATABASE_PASSWORD: dbPasswordSecret,
        ...forwarderSecrets,
      },
      healthCheckCommand: WORKER_HEALTHCHECK,
    });

    this.apiService = emailIntelApi.service;
    this.workerService = emailIntelWorker.service;

    bucket.grantReadWrite(emailIntelApi.taskDefinition.taskRole);
    bucket.grantReadWrite(emailIntelWorker.taskDefinition.taskRole);

    // Execution roles need GetSecretValue for forwarder secret (imported by name, not CDK-owned).
    secrets.emailIntelForwarder.grantRead(emailIntelApi.taskDefinition.executionRole!);
    secrets.emailIntelForwarder.grantRead(emailIntelWorker.taskDefinition.executionRole!);
    secrets.emailIntelForwarder.grantRead(emailIntelApi.taskDefinition.taskRole);
    secrets.emailIntelForwarder.grantRead(emailIntelWorker.taskDefinition.taskRole);

    const servicePairs: [string, ec2.SecurityGroup][] = [
      ["Api", emailIntelApi.securityGroup],
      ["Worker", emailIntelWorker.securityGroup],
    ];

    for (const [name, sg] of servicePairs) {
      new ec2.CfnSecurityGroupIngress(this, `EmailIntelToDb${name}`, {
        groupId: database.securityGroup.securityGroupId,
        ipProtocol: "tcp",
        fromPort: 5432,
        toPort: 5432,
        sourceSecurityGroupId: sg.securityGroupId,
      });

      new ec2.CfnSecurityGroupIngress(this, `EmailIntelToRedis${name}`, {
        groupId: redis.securityGroup.securityGroupId,
        ipProtocol: "tcp",
        fromPort: 6379,
        toPort: 6379,
        sourceSecurityGroupId: sg.securityGroupId,
      });
    }

    new CfnOutput(this, "EmailIntelServiceDns", {
      value: `email-intel.${namespace.namespaceName}:3001`,
      exportName: `${config.stackPrefix}-EmailIntelServiceDns`,
    });

    Tags.of(this).add("skout:environment", config.name);
  }
}
