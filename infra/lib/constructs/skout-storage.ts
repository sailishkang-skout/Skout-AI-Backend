import * as s3 from "aws-cdk-lib/aws-s3";
import { Duration, RemovalPolicy } from "aws-cdk-lib";
import { Construct } from "constructs";
import type { EnvironmentConfig } from "../config/environments.js";

export interface SkoutStorageProps {
  readonly config: EnvironmentConfig;
}

export class SkoutStorage extends Construct {
  readonly exportsBucket: s3.Bucket;
  readonly scrapeBucket: s3.Bucket;
  readonly emailIntelBucket: s3.Bucket;

  constructor(scope: Construct, id: string, props: SkoutStorageProps) {
    super(scope, id);

    const { config } = props;

    this.exportsBucket = new s3.Bucket(this, "ExportsBucket", {
      bucketName: undefined,
      versioned: config.s3.versioning,
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      lifecycleRules: [
        {
          expiration: Duration.days(config.s3.exportsRetentionDays),
        },
      ],
      removalPolicy: config.name === "prod" ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
      autoDeleteObjects: config.name !== "prod",
    });

    this.scrapeBucket = new s3.Bucket(this, "ScrapeBucket", {
      bucketName: undefined,
      versioned: config.s3.versioning,
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      lifecycleRules: [
        {
          prefix: "raw/",
          transitions: [
            {
              storageClass: s3.StorageClass.GLACIER,
              transitionAfter: Duration.days(90),
            },
          ],
        },
        {
          prefix: "quarantine/",
          expiration: Duration.days(30),
        },
      ],
      removalPolicy: config.name === "prod" ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
      autoDeleteObjects: config.name !== "prod",
    });

    this.emailIntelBucket = new s3.Bucket(this, "EmailIntelBucket", {
      bucketName: undefined,
      versioned: config.s3.versioning,
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      lifecycleRules: [
        {
          expiration: Duration.days(config.s3.exportsRetentionDays),
        },
      ],
      removalPolicy: config.name === "prod" ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
      autoDeleteObjects: config.name !== "prod",
    });
  }
}
