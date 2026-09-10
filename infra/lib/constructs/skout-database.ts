import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as rds from "aws-cdk-lib/aws-rds";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import { RemovalPolicy, Duration } from "aws-cdk-lib";
import { Construct } from "constructs";
import type { EnvironmentConfig } from "../config/environments.js";

export interface SkoutDatabaseProps {
  readonly vpc: ec2.IVpc;
  readonly config: EnvironmentConfig;
}

export class SkoutDatabase extends Construct {
  readonly secret: secretsmanager.ISecret;
  readonly instance: rds.DatabaseInstance;
  readonly securityGroup: ec2.SecurityGroup;

  constructor(scope: Construct, id: string, props: SkoutDatabaseProps) {
    super(scope, id);

    const { vpc, config } = props;

    this.secret = new secretsmanager.Secret(this, "DbSecret", {
      secretName: `${config.stackPrefix}/database`,
      generateSecretString: {
        secretStringTemplate: JSON.stringify({ username: "skout" }),
        generateStringKey: "password",
        excludePunctuation: true,
      },
    });

    this.securityGroup = new ec2.SecurityGroup(this, "DbSg", {
      vpc,
      description: "Skout PostgreSQL",
      allowAllOutbound: true,
    });

    this.instance = new rds.DatabaseInstance(this, "Postgres", {
      engine: rds.DatabaseInstanceEngine.postgres({
        version: rds.PostgresEngineVersion.VER_16,
      }),
      instanceType: new ec2.InstanceType(config.database.instanceClass),
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      securityGroups: [this.securityGroup],
      credentials: rds.Credentials.fromSecret(this.secret),
      databaseName: "skout",
      allocatedStorage: config.database.allocatedStorageGb,
      maxAllocatedStorage: config.database.allocatedStorageGb * 2,
      multiAz: config.database.multiAz,
      backupRetention: Duration.days(config.database.backupRetentionDays),
      deletionProtection: config.database.deletionProtection,
      removalPolicy: config.name === "prod" ? RemovalPolicy.SNAPSHOT : RemovalPolicy.DESTROY,
      publiclyAccessible: false,
    });
  }
}
