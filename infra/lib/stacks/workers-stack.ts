import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as ecr from "aws-cdk-lib/aws-ecr";
import * as events from "aws-cdk-lib/aws-events";
import * as targets from "aws-cdk-lib/aws-events-targets";
import * as sqs from "aws-cdk-lib/aws-sqs";
import * as s3 from "aws-cdk-lib/aws-s3";
import { Stack, StackProps, CfnOutput, Duration, Tags } from "aws-cdk-lib";
import { Construct } from "constructs";
import type { EnvironmentConfig } from "../config/environments.js";
import type { SkoutAppSecrets } from "../constructs/skout-app-secrets.js";
import type { SkoutDatabase } from "../constructs/skout-database.js";
import type { SkoutRedis } from "../constructs/skout-redis.js";
import { SkoutWorkerService } from "../constructs/skout-worker-service.js";

export interface WorkersStackProps extends StackProps {
  readonly config: EnvironmentConfig;
  readonly vpc: ec2.IVpc;
  readonly cluster: ecs.ICluster;
  readonly database: SkoutDatabase;
  readonly redis: SkoutRedis;
  readonly secrets: SkoutAppSecrets;
  readonly scrapeBucket: s3.IBucket;
  readonly orchestratorRepository: ecr.IRepository;
  readonly cleanerRepository: ecr.IRepository;
  readonly ingestorRepository: ecr.IRepository;
  readonly scraperImageTag?: string;
}

const SCRAPER_CPU = 256;
const SCRAPER_MEMORY_MIB = 512;

/**
 * Corpus pipeline workers — BullMQ consumers on Redis + scrape schedule SQS.
 */
export class WorkersStack extends Stack {
  readonly scrapeScheduleQueue: sqs.Queue;
  readonly orchestratorService: ecs.FargateService;
  readonly cleanerService: ecs.FargateService;
  readonly ingestorService: ecs.FargateService;

  constructor(scope: Construct, id: string, props: WorkersStackProps) {
    super(scope, id, props);

    const {
      config,
      vpc,
      cluster,
      database,
      redis,
      secrets,
      scrapeBucket,
      orchestratorRepository,
      cleanerRepository,
      ingestorRepository,
      scraperImageTag,
    } = props;

    const dlq = new sqs.Queue(this, "ScrapeScheduleDlq", {
      queueName: `${config.stackPrefix}-scrape-schedule-dlq`,
      retentionPeriod: Duration.days(14),
    });

    this.scrapeScheduleQueue = new sqs.Queue(this, "ScrapeScheduleQueue", {
      queueName: `${config.stackPrefix}-scrape-schedule`,
      visibilityTimeout: Duration.minutes(15),
      deadLetterQueue: { queue: dlq, maxReceiveCount: 3 },
    });

    new events.Rule(this, "DailyScrapeSchedule", {
      ruleName: `${config.stackPrefix}-daily-scrape`,
      description: "Triggers daily corpus scrape jobs (orchestrator consumes SQS)",
      schedule: events.Schedule.cron({ minute: "0", hour: "3", weekDay: "MON-FRI" }),
      targets: [
        new targets.SqsQueue(this.scrapeScheduleQueue, {
          message: events.RuleTargetInput.fromObject({
            source: "eventbridge",
            action: "schedule_daily_scrape",
            environment: config.name,
          }),
        }),
      ],
    });

    const scraperEnv = {
      NODE_ENV: "production",
      REDIS_URL: `redis://${redis.endpoint}:6379`,
      SCRAPE_BUCKET: scrapeBucket.bucketName,
      AWS_REGION: config.region,
      DATABASE_HOST: database.instance.dbInstanceEndpointAddress,
      DATABASE_PORT: database.instance.dbInstanceEndpointPort,
      DATABASE_NAME: "skout",
      DATABASE_USER: "skout",
    };

    const dbPasswordSecret = ecs.Secret.fromSecretsManager(database.secret, "password");

    const grantExecutionRoleRead = (
      taskDef: ecs.FargateTaskDefinition,
      ...smSecrets: import("aws-cdk-lib/aws-secretsmanager").ISecret[]
    ) => {
      const role = taskDef.executionRole;
      if (!role) return;
      for (const secret of smSecrets) {
        secret.grantRead(role);
      }
    };

    const orchestrator = new SkoutWorkerService(this, "ScraperOrchestrator", {
      vpc,
      cluster,
      repository: orchestratorRepository,
      imageTag: scraperImageTag,
      serviceName: "scraper-orchestrator",
      environmentName: config.name,
      cpu: SCRAPER_CPU,
      memoryMiB: SCRAPER_MEMORY_MIB,
      desiredCount: 1,
      environment: scraperEnv,
      secrets: { DATABASE_PASSWORD: dbPasswordSecret },
    });

    const cleaner = new SkoutWorkerService(this, "ScraperCleaner", {
      vpc,
      cluster,
      repository: cleanerRepository,
      imageTag: scraperImageTag,
      serviceName: "scraper-cleaner",
      environmentName: config.name,
      cpu: SCRAPER_CPU,
      memoryMiB: SCRAPER_MEMORY_MIB,
      desiredCount: 1,
      environment: scraperEnv,
      secrets: { DATABASE_PASSWORD: dbPasswordSecret },
    });

    const ingestor = new SkoutWorkerService(this, "ScraperIngestor", {
      vpc,
      cluster,
      repository: ingestorRepository,
      imageTag: scraperImageTag,
      serviceName: "scraper-ingestor",
      environmentName: config.name,
      cpu: SCRAPER_CPU,
      memoryMiB: SCRAPER_MEMORY_MIB,
      desiredCount: 1,
      environment: scraperEnv,
      secrets: {
        DATABASE_PASSWORD: dbPasswordSecret,
        OPENSEARCH_URL: ecs.Secret.fromSecretsManager(secrets.opensearch, "OPENSEARCH_URL"),
        OPENSEARCH_USERNAME: ecs.Secret.fromSecretsManager(secrets.opensearch, "OPENSEARCH_USERNAME"),
        OPENSEARCH_PASSWORD: ecs.Secret.fromSecretsManager(secrets.opensearch, "OPENSEARCH_PASSWORD"),
      },
    });

    this.orchestratorService = orchestrator.service;
    this.cleanerService = cleaner.service;
    this.ingestorService = ingestor.service;

    const workerPairs: [string, ec2.SecurityGroup][] = [
      ["Orchestrator", orchestrator.securityGroup],
      ["Cleaner", cleaner.securityGroup],
      ["Ingestor", ingestor.securityGroup],
    ];

    for (const [name, sg] of workerPairs) {
      new ec2.CfnSecurityGroupIngress(this, `WorkersToDb${name}`, {
        groupId: database.securityGroup.securityGroupId,
        ipProtocol: "tcp",
        fromPort: 5432,
        toPort: 5432,
        sourceSecurityGroupId: sg.securityGroupId,
      });

      new ec2.CfnSecurityGroupIngress(this, `WorkersToRedis${name}`, {
        groupId: redis.securityGroup.securityGroupId,
        ipProtocol: "tcp",
        fromPort: 6379,
        toPort: 6379,
        sourceSecurityGroupId: sg.securityGroupId,
      });
    }

    scrapeBucket.grantReadWrite(orchestrator.taskDefinition.taskRole);
    scrapeBucket.grantReadWrite(cleaner.taskDefinition.taskRole);
    scrapeBucket.grantReadWrite(ingestor.taskDefinition.taskRole);

    for (const worker of [orchestrator, cleaner, ingestor]) {
      grantExecutionRoleRead(worker.taskDefinition, database.secret);
    }
    grantExecutionRoleRead(ingestor.taskDefinition, secrets.opensearch);

    new CfnOutput(this, "ScrapeScheduleQueueUrl", {
      value: this.scrapeScheduleQueue.queueUrl,
      exportName: `${config.stackPrefix}-ScrapeScheduleQueue`,
    });

    Tags.of(this).add("skout:environment", config.name);
  }
}
