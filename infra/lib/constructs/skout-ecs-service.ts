import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as ecr from "aws-cdk-lib/aws-ecr";
import * as elbv2 from "aws-cdk-lib/aws-elasticloadbalancingv2";
import * as logs from "aws-cdk-lib/aws-logs";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import { Duration, RemovalPolicy } from "aws-cdk-lib";
import { Construct } from "constructs";

export interface SkoutEcsServiceProps {
  readonly vpc: ec2.IVpc;
  readonly cluster: ecs.ICluster;
  readonly repository: ecr.IRepository;
  readonly imageTag?: string;
  readonly serviceName: string;
  /** e.g. dev, prod — scopes CloudWatch log group names per environment */
  readonly environmentName: string;
  readonly containerPort: number;
  readonly cpu: number;
  readonly memoryMiB: number;
  readonly desiredCount: number;
  readonly environment?: Record<string, string>;
  readonly secrets?: Record<string, ecs.Secret>;
  readonly healthCheckPath: string;
  /** ALB target group healthy HTTP codes (default 200). Use 200-399 for Next.js redirects. */
  readonly healthyHttpCodes?: string;
  /** ECS container health check. Omit for ALB-only checks (recommended for Next.js on small Fargate). */
  readonly containerHealthCheckCommand?: string[];
  /** ECS container health check timeout (default 5s). Use 15s+ for Next.js on small Fargate CPU. */
  readonly healthCheckTimeout?: Duration;
  readonly listener?: elbv2.ApplicationListener;
  readonly pathPatterns?: string[];
  readonly priority?: number;
  readonly internalOnly?: boolean;
  /** Optional Datadog Agent sidecar (ECS Fargate APM). App keeps running if agent fails. */
  readonly datadog?: {
    readonly apiKeySecret: ecs.Secret;
    readonly site: string;
  };
}

export class SkoutEcsService extends Construct {
  readonly taskDefinition: ecs.FargateTaskDefinition;
  readonly service: ecs.FargateService;
  readonly securityGroup: ec2.SecurityGroup;
  readonly targetGroup?: elbv2.ApplicationTargetGroup;

  constructor(scope: Construct, id: string, props: SkoutEcsServiceProps) {
    super(scope, id);

    this.taskDefinition = new ecs.FargateTaskDefinition(this, "TaskDef", {
      cpu: props.cpu,
      memoryLimitMiB: props.memoryMiB,
    });
    const taskDef = this.taskDefinition;

    const logGroup = new logs.LogGroup(this, "LogGroup", {
      logGroupName: `/skout/${props.environmentName}/${props.serviceName}`,
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    const container = taskDef.addContainer("Container", {
      image: ecs.ContainerImage.fromEcrRepository(props.repository, props.imageTag ?? "latest"),
      logging: ecs.LogDrivers.awsLogs({ streamPrefix: props.serviceName, logGroup }),
      environment: props.environment,
      secrets: props.secrets,
      ...(props.containerHealthCheckCommand
        ? {
            healthCheck: {
              command: ["CMD-SHELL", props.containerHealthCheckCommand.join(" ")],
              interval: Duration.seconds(30),
              timeout: props.healthCheckTimeout ?? Duration.seconds(5),
              retries: 3,
              startPeriod: Duration.seconds(60),
            },
          }
        : {}),
    });

    container.addPortMappings({ containerPort: props.containerPort });

    if (props.datadog) {
      container.addEnvironment("DD_AGENT_HOST", "127.0.0.1");
      container.addEnvironment("DD_TRACE_AGENT_PORT", "8126");
      container.addEnvironment("DD_SITE", props.datadog.site);

      taskDef.addContainer("DatadogAgent", {
        image: ecs.ContainerImage.fromRegistry("public.ecr.aws/datadog/agent:latest"),
        essential: false,
        environment: {
          DD_SITE: props.datadog.site,
          ECS_FARGATE: "true",
          DD_APM_ENABLED: "true",
          DD_LOGS_ENABLED: "false",
          DD_PROCESS_AGENT_ENABLED: "false",
        },
        secrets: {
          DD_API_KEY: props.datadog.apiKeySecret,
        },
        logging: ecs.LogDrivers.awsLogs({ streamPrefix: "datadog-agent", logGroup }),
      });
    }

    const sg = new ec2.SecurityGroup(this, "ServiceSg", {
      vpc: props.vpc,
      description: `Skout ${props.serviceName} ECS`,
      allowAllOutbound: true,
    });
    this.securityGroup = sg;

    const hasAlb = !props.internalOnly && props.listener;

    this.service = new ecs.FargateService(this, "Service", {
      cluster: props.cluster,
      serviceName: props.serviceName,
      taskDefinition: taskDef,
      desiredCount: props.desiredCount,
      securityGroups: [sg],
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      assignPublicIp: false,
      circuitBreaker: { rollback: true },
      ...(hasAlb ? { healthCheckGracePeriod: Duration.seconds(120) } : {}),
    });

    if (hasAlb) {
      this.targetGroup = new elbv2.ApplicationTargetGroup(this, "TargetGroup", {
        vpc: props.vpc,
        port: props.containerPort,
        protocol: elbv2.ApplicationProtocol.HTTP,
        targetType: elbv2.TargetType.IP,
        healthCheck: {
          path: props.healthCheckPath,
          healthyHttpCodes: props.healthyHttpCodes ?? "200",
          interval: Duration.seconds(30),
        },
      });

      this.service.attachToApplicationTargetGroup(this.targetGroup);

      props.listener.addTargetGroups(props.serviceName, {
        targetGroups: [this.targetGroup],
        priority: props.priority ?? 10,
        conditions: props.pathPatterns
          ? [elbv2.ListenerCondition.pathPatterns(props.pathPatterns)]
          : undefined,
      });
      sg.connections.allowFrom(props.listener.connections, ec2.Port.tcp(props.containerPort));
    }
  }
}

export function secretFromArn(_name: string, secret: secretsmanager.ISecret, field: string): ecs.Secret {
  return ecs.Secret.fromSecretsManager(secret, field);
}
