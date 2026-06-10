import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as events from "aws-cdk-lib/aws-events";
import * as targets from "aws-cdk-lib/aws-events-targets";
import * as sqs from "aws-cdk-lib/aws-sqs";
import * as s3 from "aws-cdk-lib/aws-s3";
import { Stack, StackProps, CfnOutput, Duration, Tags } from "aws-cdk-lib";
import { Construct } from "constructs";
import type { EnvironmentConfig } from "../config/environments.js";

export interface WorkersStackProps extends StackProps {
  readonly config: EnvironmentConfig;
  readonly vpc: ec2.IVpc;
  readonly scrapeBucket: s3.IBucket;
}

/**
 * Async worker infrastructure — scrape schedule queue + EventBridge.
 * ECR repos live in RegistryStack; ECS worker services added when images exist.
 */
export class WorkersStack extends Stack {
  readonly scrapeScheduleQueue: sqs.Queue;

  constructor(scope: Construct, id: string, props: WorkersStackProps) {
    super(scope, id, props);

    const { config } = props;

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

    new CfnOutput(this, "ScrapeScheduleQueueUrl", {
      value: this.scrapeScheduleQueue.queueUrl,
      exportName: `${config.stackPrefix}-ScrapeScheduleQueue`,
    });

    Tags.of(this).add("skout:environment", config.name);
  }
}
