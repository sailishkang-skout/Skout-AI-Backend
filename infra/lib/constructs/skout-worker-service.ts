import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as ecr from "aws-cdk-lib/aws-ecr";
import * as logs from "aws-cdk-lib/aws-logs";
import { Duration, RemovalPolicy } from "aws-cdk-lib";
import { Construct } from "constructs";

export interface SkoutWorkerServiceProps {
  readonly vpc: ec2.IVpc;
  readonly cluster: ecs.ICluster;
  readonly repository: ecr.IRepository;
  readonly imageTag?: string;
  readonly serviceName: string;
  /** e.g. dev, prod — scopes CloudWatch log group names per environment */
  readonly environmentName: string;
  readonly cpu: number;
  readonly memoryMiB: number;
  readonly desiredCount: number;
  readonly environment?: Record<string, string>;
  readonly secrets?: Record<string, ecs.Secret>;
}

/** Background BullMQ / queue consumer — no ALB, no container port. */
export class SkoutWorkerService extends Construct {
  readonly taskDefinition: ecs.FargateTaskDefinition;
  readonly service: ecs.FargateService;
  readonly securityGroup: ec2.SecurityGroup;

  constructor(scope: Construct, id: string, props: SkoutWorkerServiceProps) {
    super(scope, id);

    this.taskDefinition = new ecs.FargateTaskDefinition(this, "TaskDef", {
      cpu: props.cpu,
      memoryLimitMiB: props.memoryMiB,
    });

    const logGroup = new logs.LogGroup(this, "LogGroup", {
      logGroupName: `/skout/${props.environmentName}/${props.serviceName}`,
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    this.taskDefinition.addContainer("Container", {
      image: ecs.ContainerImage.fromEcrRepository(props.repository, props.imageTag ?? "latest"),
      logging: ecs.LogDrivers.awsLogs({ streamPrefix: props.serviceName, logGroup }),
      environment: props.environment,
      secrets: props.secrets,
      healthCheck: {
        command: ["CMD-SHELL", "node -e \"process.exit(0)\""],
        interval: Duration.seconds(30),
        timeout: Duration.seconds(5),
        retries: 3,
        startPeriod: Duration.seconds(120),
      },
    });

    this.securityGroup = new ec2.SecurityGroup(this, "ServiceSg", {
      vpc: props.vpc,
      description: `Skout ${props.serviceName} worker`,
      allowAllOutbound: true,
    });

    this.service = new ecs.FargateService(this, "Service", {
      cluster: props.cluster,
      serviceName: props.serviceName,
      taskDefinition: this.taskDefinition,
      desiredCount: props.desiredCount,
      securityGroups: [this.securityGroup],
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      assignPublicIp: false,
      circuitBreaker: { rollback: false },
      minHealthyPercent: 0,
    });
  }
}
