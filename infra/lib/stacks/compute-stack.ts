import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as ecr from "aws-cdk-lib/aws-ecr";
import * as apigwv2 from "aws-cdk-lib/aws-apigatewayv2";
import * as apigwIntegrations from "aws-cdk-lib/aws-apigatewayv2-integrations";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import * as origins from "aws-cdk-lib/aws-cloudfront-origins";
import * as elbv2 from "aws-cdk-lib/aws-elasticloadbalancingv2";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import * as servicediscovery from "aws-cdk-lib/aws-servicediscovery";
import * as iam from "aws-cdk-lib/aws-iam";
import { Stack, StackProps, CfnOutput, Tags } from "aws-cdk-lib";
import { Construct } from "constructs";
import type { EnvironmentConfig } from "../config/environments.js";
import type { SkoutAppSecrets } from "../constructs/skout-app-secrets.js";
import { SkoutEcsService } from "../constructs/skout-ecs-service.js";
import type { SkoutDatabase } from "../constructs/skout-database.js";
import type { SkoutRedis } from "../constructs/skout-redis.js";
import { SkoutClickHouse } from "../constructs/skout-clickhouse.js";

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
  /** `none` = ALB HTTP only; `apigateway` = HTTPS via API Gateway (mobile-friendly); `cloudfront` = HTTPS via CloudFront. */
  readonly httpsMode?: "none" | "apigateway" | "cloudfront";
}

export class ComputeStack extends Stack {
  readonly loadBalancer: elbv2.ApplicationLoadBalancer;
  readonly cluster: ecs.Cluster;
  readonly apiService: ecs.FargateService;
  readonly apiLogGroupName: string;
  readonly clickhouse?: SkoutClickHouse;

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
      httpsMode = "none",
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

    // When an HTTPS front door (API Gateway / CloudFront) is used, lock the public ALB so plain
    // HTTP is rejected: only requests carrying the secret origin-verify header (injected by the
    // front door) reach the services. This makes the direct http://<alb-dns> URL return 403.
    const httpsFrontDoor = httpsMode === "apigateway" || httpsMode === "cloudfront";
    const ORIGIN_VERIFY_HEADER = "X-Origin-Verify";
    const originVerifySecret =
      (this.node.tryGetContext("originVerifySecret") as string | undefined) ??
      process.env.ORIGIN_VERIFY_SECRET ??
      `skout-${config.name}-${this.account}-origin-verify`;
    const originVerifyCondition = elbv2.ListenerCondition.httpHeader(ORIGIN_VERIFY_HEADER, [
      originVerifySecret,
    ]);
    const albExtraConditions = httpsFrontDoor ? [originVerifyCondition] : [];

    const listener = this.loadBalancer.addListener("HttpListener", {
      port: 80,
      open: true,
      defaultAction: httpsFrontDoor
        ? elbv2.ListenerAction.fixedResponse(403, {
            contentType: "text/plain",
            messageBody: "Direct HTTP access is not allowed. Use the HTTPS endpoint.",
          })
        : elbv2.ListenerAction.fixedResponse(404, {
            contentType: "text/plain",
            messageBody: "Not Found",
          }),
    });

    const albDns = this.loadBalancer.loadBalancerDnsName;

    /** Headers injected on API Gateway → ALB so Next/Clerk see the public HTTPS host, not the ALB DNS. */
    const buildApigwProxyMapping = (apigwHost: string, publicOrigin: string) =>
      new apigwv2.ParameterMapping()
        .overwriteHeader(ORIGIN_VERIFY_HEADER, apigwv2.MappingValue.custom(originVerifySecret))
        .overwriteHeader("host", apigwv2.MappingValue.custom(apigwHost))
        .overwriteHeader("x-skout-public-origin", apigwv2.MappingValue.custom(publicOrigin));

    // HTTPS: custom domain, API Gateway (mobile/cellular-friendly), or CloudFront in front of ALB.
    // Plain HTTP on ALB port 80 often times out on mobile data — use apigateway or cloudfront.
    let publicUrl: string;
    let httpsDistribution: cloudfront.Distribution | undefined;
    let httpsApi: apigwv2.HttpApi | undefined;

    if (config.domainName) {
      publicUrl = `https://${config.webSubdomain}.${config.domainName}`;
    } else if (httpsMode === "cloudfront") {
      httpsDistribution = new cloudfront.Distribution(this, "HttpsDistribution", {
        comment: `Skout ${config.name} HTTPS via CloudFront`,
        defaultBehavior: {
          origin: new origins.LoadBalancerV2Origin(this.loadBalancer, {
            protocolPolicy: cloudfront.OriginProtocolPolicy.HTTP_ONLY,
            customHeaders: { [ORIGIN_VERIFY_HEADER]: originVerifySecret },
          }),
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
          cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
          originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER,
        },
      });
      publicUrl = `https://${httpsDistribution.distributionDomainName}`;
    } else if (httpsMode === "apigateway") {
      httpsApi = new apigwv2.HttpApi(this, "HttpsApi", {
        apiName: `${config.stackPrefix}-https`.substring(0, 128),
        description: `Skout ${config.name} HTTPS entry (API Gateway → ALB)`,
      });

      const apigwHost = `${httpsApi.httpApiId}.execute-api.${Stack.of(this).region}.${Stack.of(this).urlSuffix}`;
      publicUrl = `https://${apigwHost}`;

      httpsApi.addRoutes({
        path: "/{proxy+}",
        methods: [apigwv2.HttpMethod.ANY],
        integration: new apigwIntegrations.HttpUrlIntegration(
          "AlbProxyIntegration",
          `http://${albDns}/{proxy}`,
          { method: apigwv2.HttpMethod.ANY, parameterMapping: buildApigwProxyMapping(apigwHost, publicUrl) }
        ),
      });

      httpsApi.addRoutes({
        path: "/",
        methods: [apigwv2.HttpMethod.ANY],
        integration: new apigwIntegrations.HttpUrlIntegration(
          "AlbRootIntegration",
          `http://${albDns}/`,
          { method: apigwv2.HttpMethod.ANY, parameterMapping: buildApigwProxyMapping(apigwHost, publicUrl) }
        ),
      });
    } else {
      publicUrl = `http://${albDns}`;
    }

    const corsOrigin = config.domainName
      ? publicUrl
      : `${publicUrl},http://${albDns}`;

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
      extraConditions: albExtraConditions,
      environment: {
        NODE_ENV: "production",
        PORT: "3001",
        HOST: "0.0.0.0",
        CORS_ORIGIN: corsOrigin,
        API_PUBLIC_URL: publicUrl,
        FRONTEND_URL: publicUrl,
        REDIS_URL: `redis://${redis.endpoint}:6379`,
        EXPORTS_BUCKET: exportsBucket.bucketName,
        SCRAPE_BUCKET: scrapeBucket.bucketName,
        AI_SERVICE_URL: aiServiceUrl,
        DATABASE_HOST: database.instance.dbInstanceEndpointAddress,
        DATABASE_PORT: database.instance.dbInstanceEndpointPort,
        DATABASE_NAME: "skout",
        DATABASE_USER: "skout",
        SERVICE_NAME: "skout-api",
        LOG_LEVEL: "info",
        TRUST_PROXY: "true",
        DD_SERVICE: "skout-api",
        DD_ENV: config.name,
        DD_SITE: "us5.datadoghq.com",
        CRM_SECRETS_PREFIX: `${config.stackPrefix}/crm`,
        RATE_LIMIT_MAX: "200",
        RATE_LIMIT_WINDOW_MS: "60000",
        // Dev: allow phone waterfall for typical test leads (score ~40); prod keeps default 80 via app env schema.
        ...(config.name === "dev"
          ? {
              ENRICHMENT_PHONE_SCORE_GATE: "39",
              RAZORPAY_KEY_ID: "rzp_test_T7RSEsGBVeHtUD",
              RAZORPAY_CREDIT_PACKS_JSON:
                '[{"id":"starter","label":"Starter","credits":500,"amountInr":499},{"id":"growth","label":"Growth","credits":2000,"amountInr":1499},{"id":"scale","label":"Scale","credits":10000,"amountInr":4999}]',
            }
          : {}),
      },
      secrets: {
        DATABASE_PASSWORD: ecs.Secret.fromSecretsManager(database.secret, "password"),
        CLERK_SECRET_KEY: ecs.Secret.fromSecretsManager(secrets.clerk, "CLERK_SECRET_KEY"),
        APOLLO_API_KEY: ecs.Secret.fromSecretsManager(secrets.apollo, "APOLLO_API_KEY"),
        HUNTER_API_KEY: ecs.Secret.fromSecretsManager(secrets.hunter, "HUNTER_API_KEY"),
        MILLIONVERIFIER_API_KEY: ecs.Secret.fromSecretsManager(secrets.enrichmentProviders, "MILLIONVERIFIER_API_KEY"),
        ZEROBOUNCE_API_KEY: ecs.Secret.fromSecretsManager(secrets.enrichmentProviders, "ZEROBOUNCE_API_KEY"),
        NEVERBOUNCE_API_KEY: ecs.Secret.fromSecretsManager(secrets.enrichmentProviders, "NEVERBOUNCE_API_KEY"),
        PDL_API_KEY: ecs.Secret.fromSecretsManager(secrets.enrichmentProviders, "PDL_API_KEY"),
        REVENUEBASE_API_KEY: ecs.Secret.fromSecretsManager(secrets.enrichmentProviders, "REVENUEBASE_API_KEY"),
        EXPLORIUM_API_KEY: ecs.Secret.fromSecretsManager(secrets.enrichmentProviders, "EXPLORIUM_API_KEY"),
        CORESIGNAL_API_KEY: ecs.Secret.fromSecretsManager(secrets.enrichmentProviders, "CORESIGNAL_API_KEY"),
        DATAGMA_API_KEY: ecs.Secret.fromSecretsManager(secrets.enrichmentProviders, "DATAGMA_API_KEY"),
        CONTACTOUT_API_KEY: ecs.Secret.fromSecretsManager(secrets.enrichmentProviders, "CONTACTOUT_API_KEY"),
        COGNISM_API_KEY: ecs.Secret.fromSecretsManager(secrets.enrichmentProviders, "COGNISM_API_KEY"),
        OPENCORPORATES_API_KEY: ecs.Secret.fromSecretsManager(secrets.enrichmentProviders, "OPENCORPORATES_API_KEY"),
        HUBSPOT_CLIENT_ID: ecs.Secret.fromSecretsManager(secrets.hubspot, "HUBSPOT_CLIENT_ID"),
        HUBSPOT_CLIENT_SECRET: ecs.Secret.fromSecretsManager(secrets.hubspot, "HUBSPOT_CLIENT_SECRET"),
        OPENSEARCH_URL: ecs.Secret.fromSecretsManager(secrets.opensearch, "OPENSEARCH_URL"),
        OPENSEARCH_USERNAME: ecs.Secret.fromSecretsManager(secrets.opensearch, "OPENSEARCH_USERNAME"),
        OPENSEARCH_PASSWORD: ecs.Secret.fromSecretsManager(secrets.opensearch, "OPENSEARCH_PASSWORD"),
        CLICKHOUSE_URL: ecs.Secret.fromSecretsManager(secrets.clickhouse, "CLICKHOUSE_URL"),
        SENTRY_DSN: ecs.Secret.fromSecretsManager(secrets.sentry, "SENTRY_DSN"),
        POSTHOG_API_KEY: ecs.Secret.fromSecretsManager(secrets.posthog, "POSTHOG_API_KEY"),
        INTEGRATION_ENCRYPTION_KEY: ecs.Secret.fromSecretsManager(
          secrets.appConfig,
          "INTEGRATION_ENCRYPTION_KEY"
        ),
        DD_API_KEY: ecs.Secret.fromSecretsManager(secrets.datadog, "DD_API_KEY"),
        RAZORPAY_KEY_SECRET: ecs.Secret.fromSecretsManager(secrets.razorpay, "RAZORPAY_KEY_SECRET"),
        RAZORPAY_WEBHOOK_SECRET: ecs.Secret.fromSecretsManager(
          secrets.razorpay,
          "RAZORPAY_WEBHOOK_SECRET"
        ),
      },
      datadog: {
        apiKeySecret: ecs.Secret.fromSecretsManager(secrets.datadog, "DD_API_KEY"),
        site: "us5.datadoghq.com",
      },
    });

    const stack = Stack.of(this);
    apiEcs.taskDefinition.taskRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: [
          "secretsmanager:GetSecretValue",
          "secretsmanager:PutSecretValue",
          "secretsmanager:CreateSecret",
          "secretsmanager:DeleteSecret",
          "secretsmanager:DescribeSecret",
        ],
        resources: [
          `arn:aws:secretsmanager:${stack.region}:${stack.account}:secret:${config.stackPrefix}/crm/*`,
        ],
      })
    );

    this.apiService = apiEcs.service;
    this.apiLogGroupName = `/skout/${config.name}/api`;

    if (config.clickhouse?.enabled) {
      this.clickhouse = new SkoutClickHouse(this, "ClickHouse", {
        vpc,
        cluster: this.cluster,
        namespace,
        config,
        clickhouseSecret: secrets.clickhouse,
        clientSecurityGroups: [apiEcs.securityGroup],
      });

      new CfnOutput(this, "ClickHouseHost", {
        value: `clickhouse.${namespace.namespaceName}`,
        description: "VPC-internal ClickHouse DNS (port 8123)",
        exportName: `${config.stackPrefix}-ClickHouseHost`,
      });

      new CfnOutput(this, "ClickHouseUrl", {
        value: this.clickhouse.httpUrl,
        description: "VPC-internal ClickHouse URL (synced to Secrets Manager SkoutDev/clickhouse)",
        exportName: `${config.stackPrefix}-ClickHouseUrl`,
      });
    }

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
      secrets.enrichmentProviders,
      secrets.hubspot,
      secrets.opensearch,
      secrets.clickhouse,
      secrets.sentry,
      secrets.posthog,
      secrets.appConfig,
      secrets.datadog
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
        POSTHOG_HOST: "https://us.i.posthog.com",
      },
      secrets: {
        OPENAI_API_KEY: ecs.Secret.fromSecretsManager(secrets.openai, "OPENAI_API_KEY"),
        SENTRY_DSN: ecs.Secret.fromSecretsManager(secrets.sentry, "SENTRY_DSN_AI"),
        POSTHOG_PROJECT_TOKEN: ecs.Secret.fromSecretsManager(secrets.posthog, "POSTHOG_API_KEY"),
      },
    });

    grantSecretRead(aiService.taskDefinition, secrets.openai, secrets.sentry, secrets.posthog);

    apiEcs.service.connections.allowTo(aiService.service, ec2.Port.tcp(8000));

    aiService.service.enableCloudMap({
      name: "ai",
      cloudMapNamespace: namespace,
      dnsRecordType: servicediscovery.DnsRecordType.A,
    });

    const apiUrl = publicUrl;

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
      extraConditions: albExtraConditions,
      environment: {
        NODE_ENV: "production",
        NEXT_PUBLIC_API_URL: apiUrl,
        NEXT_PUBLIC_APP_URL: publicUrl,
        NEXT_PUBLIC_CLERK_SIGN_IN_URL: `${publicUrl}/sign-in`,
        NEXT_PUBLIC_CLERK_SIGN_UP_URL: `${publicUrl}/sign-up`,
        CLERK_SIGN_IN_URL: `${publicUrl}/sign-in`,
        CLERK_SIGN_UP_URL: `${publicUrl}/sign-up`,
      },
      secrets: {
        CLERK_SECRET_KEY: ecs.Secret.fromSecretsManager(secrets.clerk, "CLERK_SECRET_KEY"),
        NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: ecs.Secret.fromSecretsManager(
          secrets.clerk,
          "CLERK_PUBLISHABLE_KEY"
        ),
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

    if (httpsDistribution) {
      new CfnOutput(this, "CloudFrontDomain", {
        value: httpsDistribution.distributionDomainName,
        exportName: `${config.stackPrefix}-CloudFrontDomain`,
      });
    }

    if (httpsApi) {
      new CfnOutput(this, "ApiGatewayUrl", {
        value: httpsApi.url!,
        exportName: `${config.stackPrefix}-ApiGatewayUrl`,
      });
    }

    new CfnOutput(this, "ApiUrl", {
      value: `${apiUrl}/api/v1`,
      exportName: `${config.stackPrefix}-ApiUrl`,
    });

    new CfnOutput(this, "WebUrl", {
      value: apiUrl,
      description: "Primary HTTPS URL for web + API (use this on mobile)",
      exportName: `${config.stackPrefix}-WebUrl`,
    });

    new CfnOutput(this, "AlbHttpUrl", {
      value: `http://${albDns}`,
      description: httpsFrontDoor
        ? "Internal ALB origin — direct HTTP returns 403; use WebUrl (HTTPS)"
        : "Direct ALB HTTP URL (legacy; prefer WebUrl)",
      exportName: `${config.stackPrefix}-AlbHttpUrl`,
    });

    Tags.of(this).add("skout:environment", config.name);
  }
}
