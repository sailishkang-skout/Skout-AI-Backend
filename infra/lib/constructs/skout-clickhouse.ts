import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as logs from "aws-cdk-lib/aws-logs";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import * as servicediscovery from "aws-cdk-lib/aws-servicediscovery";
import * as cr from "aws-cdk-lib/custom-resources";
import { Duration, RemovalPolicy } from "aws-cdk-lib";
import { Construct } from "constructs";
import type { EnvironmentConfig } from "../config/environments.js";

const CLICKHOUSE_USER = "skout";
const CLICKHOUSE_PASSWORD = "skout";
const CLICKHOUSE_DB = "skout";

export interface SkoutClickHouseProps {
  readonly vpc: ec2.IVpc;
  readonly cluster: ecs.ICluster;
  readonly namespace: servicediscovery.PrivateDnsNamespace;
  readonly config: EnvironmentConfig;
  readonly clickhouseSecret: secretsmanager.ISecret;
  /** Security groups allowed to query ClickHouse HTTP (8123). */
  readonly clientSecurityGroups: ec2.ISecurityGroup[];
}

/** Self-hosted ClickHouse — private Cloud Map DNS, reachable inside the VPC only. */
export class SkoutClickHouse extends Construct {
  readonly httpUrl: string;
  readonly securityGroup: ec2.SecurityGroup;
  readonly service: ecs.FargateService;

  constructor(scope: Construct, id: string, props: SkoutClickHouseProps) {
    super(scope, id);

    const { vpc, cluster, namespace, config, clickhouseSecret, clientSecurityGroups } = props;
    const ch = config.clickhouse!;
    const serviceHost = `clickhouse.${namespace.namespaceName}`;

    this.httpUrl = `http://${CLICKHOUSE_USER}:${CLICKHOUSE_PASSWORD}@${serviceHost}:8123/${CLICKHOUSE_DB}`;

    this.securityGroup = new ec2.SecurityGroup(this, "ClickHouseSg", {
      vpc,
      description: `Skout ${config.name} ClickHouse`,
      allowAllOutbound: true,
    });

    for (const clientSg of clientSecurityGroups) {
      this.securityGroup.addIngressRule(clientSg, ec2.Port.tcp(8123), "ClickHouse HTTP from clients");
    }

    const taskDef = new ecs.FargateTaskDefinition(this, "TaskDef", {
      cpu: ch.cpu,
      memoryLimitMiB: ch.memoryMiB,
      ephemeralStorageGiB: 30,
    });

    const logGroup = new logs.LogGroup(this, "LogGroup", {
      logGroupName: `/skout/${config.name}/clickhouse`,
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    const container = taskDef.addContainer("Container", {
      image: ecs.ContainerImage.fromRegistry("clickhouse/clickhouse-server:24.8-alpine"),
      logging: ecs.LogDrivers.awsLogs({ streamPrefix: "clickhouse", logGroup }),
      environment: {
        CLICKHOUSE_DB,
        CLICKHOUSE_USER,
        CLICKHOUSE_PASSWORD,
        CLICKHOUSE_DEFAULT_ACCESS_MANAGEMENT: "1",
      },
      healthCheck: {
        command: [
          "CMD-SHELL",
          "clickhouse-client --host 127.0.0.1 --user skout --password skout --query 'SELECT 1' || exit 1",
        ],
        interval: Duration.seconds(30),
        timeout: Duration.seconds(10),
        retries: 5,
        startPeriod: Duration.seconds(180),
      },
    });

    container.addPortMappings({ containerPort: 8123 }, { containerPort: 9000 });

    this.service = new ecs.FargateService(this, "Service", {
      cluster,
      serviceName: "clickhouse",
      taskDefinition: taskDef,
      desiredCount: 1,
      securityGroups: [this.securityGroup],
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      assignPublicIp: false,
      cloudMapOptions: {
        name: "clickhouse",
        cloudMapNamespace: namespace,
        dnsRecordType: servicediscovery.DnsRecordType.A,
        dnsTtl: Duration.seconds(10),
      },
      circuitBreaker: { rollback: false },
      minHealthyPercent: 0,
      healthCheckGracePeriod: Duration.seconds(180),
    });

    new cr.AwsCustomResource(this, "SyncClickHouseSecret", {
      onCreate: {
        service: "SecretsManager",
        action: "putSecretValue",
        parameters: {
          SecretId: clickhouseSecret.secretArn,
          SecretString: JSON.stringify({ CLICKHOUSE_URL: this.httpUrl }),
        },
        physicalResourceId: cr.PhysicalResourceId.of(`${config.stackPrefix}-clickhouse-url`),
      },
      onUpdate: {
        service: "SecretsManager",
        action: "putSecretValue",
        parameters: {
          SecretId: clickhouseSecret.secretArn,
          SecretString: JSON.stringify({ CLICKHOUSE_URL: this.httpUrl }),
        },
      },
      policy: cr.AwsCustomResourcePolicy.fromSdkCalls({
        resources: [clickhouseSecret.secretArn],
      }),
    });

    this.node.addMetadata("clickhouseHttpUrl", this.httpUrl);
    this.node.addMetadata("clickhouseHost", serviceHost);
  }
}
