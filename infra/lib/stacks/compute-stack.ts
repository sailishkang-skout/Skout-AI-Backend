import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as ecr from "aws-cdk-lib/aws-ecr";
import * as elbv2 from "aws-cdk-lib/aws-elasticloadbalancingv2";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import * as servicediscovery from "aws-cdk-lib/aws-servicediscovery";
import { Stack, StackProps, CfnOutput, Tags } from "aws-cdk-lib";
import { Construct } from "constructs";
import type { EnvironmentConfig } from "../config/environments.js";
import type { SkoutAppSecrets } from "../constructs/skout-app-secrets.js";
import { SkoutEcsService } from "../constructs/skout-ecs-service.js";
import type { SkoutDatabase } from "../constructs/skout-database.js";
import type { SkoutRedis } from "../constructs/skout-redis.js";

export interface ComputeStackProps extends StackProps {
  readonly config: EnvironmentConfig;
  readonly vpc: ec2.IVpc;
  readonly database: SkoutDatabase;
  readonly redis: SkoutRedis;
  readonly secrets: SkoutAppSecrets;
  readonly exportsBucket: s3.IBucket;
  readonly scrapeBucket: s3.IBucket;
  readonly apiRepository: ecr.IRepository;
  readonly aiRepository: ecr.IRepository;
  readonly webRepository: ecr.IRepository;
  readonly imageTag?: string;
}

export class ComputeStack extends Stack {
  readonly loadBalancer: elbv2.ApplicationLoadBalancer;
  readonly cluster: ecs.Cluster;
  readonly apiService: ecs.FargateService;

  constructor(scope: Construct, id: string, props: ComputeStackProps) {
    super(scope, id, props);

    const {
      config,
      vpc,
      database,
      redis,
      secrets,
      exportsBucket,
      scrapeBucket,
      apiRepository,
      aiRepository,
      webRepository,
      imageTag = "latest",
    } = props;

    const nodeHttpHealthCheck = (port: number, path: string) =>
      `node -e "fetch('http://127.0.0.1:${port}${path}').then((r)=>process.exit(r.status<400?0:1)).catch(()=>process.exit(1))"`;

    const pythonHttpHealthCheck = (port: number, path: string) =>
      `python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:${port}${path}')"`;

    this.cluster = new ecs.Cluster(this, "Cluster", {
      vpc,
      clusterName: `${config.stackPrefix}-cluster`,
    });

    this.loadBalancer = new elbv2.ApplicationLoadBalancer(this, "Alb", {
      vpc,
      internetFacing: true,
      loadBalancerName: `${config.stackPrefix}-alb`.substring(0, 32),
    });

    const namespace = new servicediscovery.PrivateDnsNamespace(this, "ServiceDiscovery", {
      name: `${config.stackPrefix.toLowerCase()}.local`,
      vpc,
      description: `Skout ${config.name} internal service discovery`,
    });

    const listener = this.loadBalancer.addListener("HttpListener", {
      port: 80,
      open: true,
      defaultAction: elbv2.ListenerAction.fixedResponse(404, {
        contentType: "text/plain",
        messageBody: "Not Found",
      }),
    });

    const albDns = this.loadBalancer.loadBalancerDnsName;
    const corsOrigin = config.domainName
      ? `https://${config.webSubdomain}.${config.domainName}`
      : `http://${albDns}`;

    const aiServiceUrl = `http://ai.${namespace.namespaceName}:8000`;

    const apiEcs = new SkoutEcsService(this, "ApiService", {
      vpc,
      cluster: this.cluster,
      repository: apiRepository,
      imageTag,
      serviceName: "api",
      environmentName: config.name,
      containerPort: 3001,
      cpu: config.ecs.apiCpu,
      memoryMiB: config.ecs.apiMemoryMiB,
      desiredCount: config.ecs.apiDesiredCount,
      healthCheckPath: "/api/v1/health",
      containerHealthCheckCommand: [nodeHttpHealthCheck(3001, "/api/v1/health")],
      listener,
      pathPatterns: ["/api/*"],
      priority: 10,
      environment: {
        NODE_ENV: "production",
        PORT: "3001",
        HOST: "0.0.0.0",
        CORS_ORIGIN: corsOrigin,
        REDIS_URL: `redis://${redis.endpoint}:6379`,
        EXPORTS_BUCKET: exportsBucket.bucketName,
        SCRAPE_BUCKET: scrapeBucket.bucketName,
        AI_SERVICE_URL: aiServiceUrl,
        DATABASE_HOST: database.instance.dbInstanceEndpointAddress,
        DATABASE_PORT: database.instance.dbInstanceEndpointPort,
        DATABASE_NAME: "skout",
        DATABASE_USER: "skout",
      },
      secrets: {
        DATABASE_PASSWORD: ecs.Secret.fromSecretsManager(database.secret, "password"),
        CLERK_SECRET_KEY: ecs.Secret.fromSecretsManager(secrets.clerk, "CLERK_SECRET_KEY"),
        APOLLO_API_KEY: ecs.Secret.fromSecretsManager(secrets.apollo, "APOLLO_API_KEY"),
        HUNTER_API_KEY: ecs.Secret.fromSecretsManager(secrets.hunter, "HUNTER_API_KEY"),
        HUBSPOT_CLIENT_ID: ecs.Secret.fromSecretsManager(secrets.hubspot, "HUBSPOT_CLIENT_ID"),
        HUBSPOT_CLIENT_SECRET: ecs.Secret.fromSecretsManager(secrets.hubspot, "HUBSPOT_CLIENT_SECRET"),
        OPENSEARCH_URL: ecs.Secret.fromSecretsManager(secrets.opensearch, "OPENSEARCH_URL"),
        OPENSEARCH_USERNAME: ecs.Secret.fromSecretsManager(secrets.opensearch, "OPENSEARCH_USERNAME"),
        OPENSEARCH_PASSWORD: ecs.Secret.fromSecretsManager(secrets.opensearch, "OPENSEARCH_PASSWORD"),
        CLICKHOUSE_URL: ecs.Secret.fromSecretsManager(secrets.clickhouse, "CLICKHOUSE_URL"),
        SENTRY_DSN: ecs.Secret.fromSecretsManager(secrets.sentry, "SENTRY_DSN"),
        POSTHOG_API_KEY: ecs.Secret.fromSecretsManager(secrets.posthog, "POSTHOG_API_KEY"),
      },
    });

    this.apiService = apiEcs.service;

    const grantSecretRead = (taskDef: ecs.FargateTaskDefinition, ...appSecrets: secretsmanager.ISecret[]) => {
      const role = taskDef.executionRole;
      if (!role) return;
      for (const secret of appSecrets) {
        secret.grantRead(role);
      }
    };

    grantSecretRead(
      apiEcs.taskDefinition,
      database.secret,
      secrets.clerk,
      secrets.apollo,
      secrets.hunter,
      secrets.hubspot,
      secrets.opensearch,
      secrets.clickhouse,
      secrets.sentry,
      secrets.posthog
    );

    const aiService = new SkoutEcsService(this, "AiService", {
      vpc,
      cluster: this.cluster,
      repository: aiRepository,
      imageTag,
      serviceName: "ai",
      environmentName: config.name,
      containerPort: 8000,
      cpu: config.ecs.aiCpu,
      memoryMiB: config.ecs.aiMemoryMiB,
      desiredCount: config.ecs.aiDesiredCount,
      healthCheckPath: "/health",
      containerHealthCheckCommand: [pythonHttpHealthCheck(8000, "/health")],
      internalOnly: true,
      environment: {
        NODE_ENV: "production",
      },
      secrets: {
        OPENAI_API_KEY: ecs.Secret.fromSecretsManager(secrets.openai, "OPENAI_API_KEY"),
      },
    });

    // Imported secrets (e.g. dev openai) are not auto-granted to the execution role.
    grantSecretRead(aiService.taskDefinition, secrets.openai);

    apiEcs.service.connections.allowTo(aiService.service, ec2.Port.tcp(8000));

    aiService.service.enableCloudMap({
      name: "ai",
      cloudMapNamespace: namespace,
      dnsRecordType: servicediscovery.DnsRecordType.A,
    });

    const apiUrl = `http://${albDns}`;

    const webService = new SkoutEcsService(this, "WebService", {
      vpc,
      cluster: this.cluster,
      repository: webRepository,
      imageTag,
      serviceName: "web",
      environmentName: config.name,
      containerPort: 3000,
      cpu: config.ecs.webCpu,
      memoryMiB: config.ecs.webMemoryMiB,
      desiredCount: config.ecs.webDesiredCount,
      healthCheckPath: "/",
      healthyHttpCodes: "200-399",
      listener,
      pathPatterns: ["/*"],
      priority: 100,
      environment: {
        NODE_ENV: "production",
        NEXT_PUBLIC_API_URL: apiUrl,
      },
      secrets: {
        CLERK_PUBLISHABLE_KEY: ecs.Secret.fromSecretsManager(secrets.clerk, "CLERK_PUBLISHABLE_KEY"),
      },
    });
    grantSecretRead(webService.taskDefinition, secrets.clerk);

    new ec2.CfnSecurityGroupIngress(this, "ApiToDbIngress", {
      groupId: database.securityGroup.securityGroupId,
      ipProtocol: "tcp",
      fromPort: 5432,
      toPort: 5432,
      sourceSecurityGroupId: apiEcs.securityGroup.securityGroupId,
    });

    new ec2.CfnSecurityGroupIngress(this, "ApiToRedisIngress", {
      groupId: redis.securityGroup.securityGroupId,
      ipProtocol: "tcp",
      fromPort: 6379,
      toPort: 6379,
      sourceSecurityGroupId: apiEcs.securityGroup.securityGroupId,
    });

    exportsBucket.grantReadWrite(apiEcs.service.taskDefinition.taskRole);
    scrapeBucket.grantReadWrite(apiEcs.service.taskDefinition.taskRole);

    new CfnOutput(this, "LoadBalancerDns", {
      value: this.loadBalancer.loadBalancerDnsName,
      exportName: `${config.stackPrefix}-AlbDns`,
    });

    new CfnOutput(this, "ApiUrl", {
      value: `${apiUrl}/api/v1`,
      exportName: `${config.stackPrefix}-ApiUrl`,
    });

    new CfnOutput(this, "WebUrl", {
      value: apiUrl,
      exportName: `${config.stackPrefix}-WebUrl`,
    });

    Tags.of(this).add("skout:environment", config.name);
  }
}
