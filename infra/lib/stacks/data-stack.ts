import * as ec2 from "aws-cdk-lib/aws-ec2";
import { Stack, StackProps, CfnOutput, Tags } from "aws-cdk-lib";
import { Construct } from "constructs";
import type { EnvironmentConfig } from "../config/environments.js";
import { SkoutAppSecrets } from "../constructs/skout-app-secrets.js";
import { SkoutDatabase } from "../constructs/skout-database.js";
import { SkoutRedis } from "../constructs/skout-redis.js";
import { SkoutStorage } from "../constructs/skout-storage.js";

export interface DataStackProps extends StackProps {
  readonly config: EnvironmentConfig;
  readonly vpc: ec2.IVpc;
}

export class DataStack extends Stack {
  readonly database: SkoutDatabase;
  readonly redis: SkoutRedis;
  readonly storage: SkoutStorage;
  readonly secrets: SkoutAppSecrets;

  constructor(scope: Construct, id: string, props: DataStackProps) {
    super(scope, id, props);

    const { config, vpc } = props;

    this.database = new SkoutDatabase(this, "Database", { vpc, config });
    this.redis = new SkoutRedis(this, "Redis", { vpc, config });
    this.storage = new SkoutStorage(this, "Storage", { config });
    this.secrets = new SkoutAppSecrets(this, "AppSecrets", {
      config,
      importOpenAi: config.importOpenAiSecret,
    });

    new CfnOutput(this, "DatabaseSecretArn", {
      value: this.database.secret.secretArn,
      exportName: `${config.stackPrefix}-DbSecretArn`,
    });

    new CfnOutput(this, "RedisEndpoint", {
      value: this.redis.endpoint,
      exportName: `${config.stackPrefix}-RedisEndpoint`,
    });

    new CfnOutput(this, "ExportsBucketName", {
      value: this.storage.exportsBucket.bucketName,
      exportName: `${config.stackPrefix}-ExportsBucket`,
    });

    new CfnOutput(this, "ScrapeBucketName", {
      value: this.storage.scrapeBucket.bucketName,
      exportName: `${config.stackPrefix}-ScrapeBucketData`,
    });

    new CfnOutput(this, "EmailIntelBucketName", {
      value: this.storage.emailIntelBucket.bucketName,
      exportName: `${config.stackPrefix}-EmailIntelBucket`,
    });

    Tags.of(this).add("skout:environment", config.name);
  }
}
