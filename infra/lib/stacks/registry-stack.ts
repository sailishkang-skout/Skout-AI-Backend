import * as ecr from "aws-cdk-lib/aws-ecr";
import * as iam from "aws-cdk-lib/aws-iam";
import { Stack, StackProps, CfnOutput, RemovalPolicy, Tags, Duration } from "aws-cdk-lib";
import { Construct } from "constructs";
import type { EnvironmentConfig } from "../config/environments.js";

export interface RegistryStackProps extends StackProps {
  readonly config: EnvironmentConfig;
}

export class RegistryStack extends Stack {
  readonly apiRepository: ecr.Repository;
  readonly crmRepository: ecr.Repository;
  readonly aiRepository: ecr.Repository;
  readonly webRepository: ecr.Repository;
  readonly workerEnrichRepository: ecr.Repository;
  readonly workerExportRepository: ecr.Repository;
  readonly scraperOrchestratorRepository: ecr.Repository;
  readonly scraperBotRepository: ecr.Repository;
  readonly scraperCleanerRepository: ecr.Repository;
  readonly scraperIngestorRepository: ecr.Repository;
  readonly emailIntelRepository: ecr.Repository;
  readonly deployRole: iam.Role;

  constructor(scope: Construct, id: string, props: RegistryStackProps) {
    super(scope, id, props);

    const { config } = props;

    const removalPolicy = config.name === "prod" ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY;

    const createRepo = (id: string, repoName: string) =>
      new ecr.Repository(this, id, {
        repositoryName: repoName,
        removalPolicy,
        emptyOnDelete: config.name !== "prod",
        imageScanOnPush: true,
        lifecycleRules: [
          // Untagged images pile up from every push that overwrites `latest`/a branch tag —
          // expire them instead of paying storage for orphaned layers indefinitely.
          {
            tagStatus: ecr.TagStatus.UNTAGGED,
            maxImageAge: Duration.days(7),
            rulePriority: 1,
          },
        ],
      });

    this.apiRepository = createRepo("ApiRepo", `skout-${config.name}-api`);
    this.crmRepository = createRepo("CrmRepo", `skout-${config.name}-crm`);
    this.aiRepository = createRepo("AiRepo", `skout-${config.name}-ai`);
    this.webRepository = createRepo("WebRepo", `skout-${config.name}-web`);
    this.workerEnrichRepository = createRepo("WorkerEnrichRepo", `skout-${config.name}-worker-enrich`);
    this.workerExportRepository = createRepo("WorkerExportRepo", `skout-${config.name}-worker-export`);
    this.scraperOrchestratorRepository = createRepo(
      "ScraperOrchestratorRepo",
      `skout-${config.name}-scraper-orchestrator`
    );
    this.scraperBotRepository = createRepo("ScraperBotRepo", `skout-${config.name}-scraper-bot`);
    this.scraperCleanerRepository = createRepo("ScraperCleanerRepo", `skout-${config.name}-scraper-cleaner`);
    this.scraperIngestorRepository = createRepo("ScraperIngestorRepo", `skout-${config.name}-scraper-ingestor`);
    this.emailIntelRepository = createRepo("EmailIntelRepo", `skout-${config.name}-email-intel`);

    const githubOrg = config.github?.org ?? "sailishkang-skout";
    const backendRepo = config.github?.backendRepo ?? "Skout-AI-Backend";
    const frontendRepo = config.github?.frontendRepo ?? "Skout-AI-Frontend";

    const oidcProvider = new iam.OpenIdConnectProvider(this, "GitHubOidc", {
      url: "https://token.actions.githubusercontent.com",
      clientIds: ["sts.amazonaws.com"],
    });

    this.deployRole = new iam.Role(this, "GitHubDeployRole", {
      roleName: `${config.stackPrefix}-GitHubDeploy`,
      assumedBy: new iam.FederatedPrincipal(
        oidcProvider.openIdConnectProviderArn,
        {
          StringEquals: {
            "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
          },
          StringLike: {
            "token.actions.githubusercontent.com:sub": [
              `repo:${githubOrg}/${backendRepo}:*`,
              `repo:${githubOrg}/${frontendRepo}:*`,
            ],
          },
        },
        "sts:AssumeRoleWithWebIdentity"
      ),
      description: `GitHub Actions deploy role for Skout ${config.name}`,
    });

    const repos = [
      this.apiRepository,
      this.crmRepository,
      this.aiRepository,
      this.webRepository,
      this.workerEnrichRepository,
      this.workerExportRepository,
      this.scraperOrchestratorRepository,
      this.scraperBotRepository,
      this.scraperCleanerRepository,
      this.scraperIngestorRepository,
      this.emailIntelRepository,
    ];
    for (const repo of repos) {
      repo.grantPullPush(this.deployRole);
    }

    this.deployRole.addToPolicy(
      new iam.PolicyStatement({
        actions: [
          "ecs:UpdateService",
          "ecs:DescribeServices",
          "ecs:DescribeTaskDefinition",
          "ecs:RunTask",
          "ecs:DescribeTasks",
          "ecs:ListClusters",
          "ecs:ListServices",
          "iam:PassRole",
        ],
        resources: ["*"],
      })
    );

    // CDK deploy via GitHub Actions
    this.deployRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ["cloudformation:*", "s3:GetObject", "s3:PutObject", "s3:ListBucket"],
        resources: ["*"],
      })
    );

    this.deployRole.addToPolicy(
      new iam.PolicyStatement({
        actions: [
          "ec2:*",
          "elasticloadbalancing:*",
          "rds:*",
          "elasticache:*",
          "secretsmanager:GetSecretValue",
          "secretsmanager:DescribeSecret",
          "logs:*",
          "servicediscovery:*",
          "sqs:*",
          "events:*",
          "sns:*",
          "cloudwatch:*",
          "ecr:*",
          "iam:GetRole",
          "iam:CreateRole",
          "iam:DeleteRole",
          "iam:PutRolePolicy",
          "iam:DeleteRolePolicy",
          "iam:AttachRolePolicy",
          "iam:DetachRolePolicy",
          "iam:PassRole",
          "iam:GetRolePolicy",
          "iam:TagRole",
          "iam:UntagRole",
          "sts:AssumeRole",
        ],
        resources: ["*"],
      })
    );

    new CfnOutput(this, "ApiRepositoryUri", {
      value: this.apiRepository.repositoryUri,
      exportName: `${config.stackPrefix}-ApiRepoUri`,
    });

    new CfnOutput(this, "CrmRepositoryUri", {
      value: this.crmRepository.repositoryUri,
      exportName: `${config.stackPrefix}-CrmRepoUri`,
    });

    new CfnOutput(this, "EmailIntelRepositoryUri", {
      value: this.emailIntelRepository.repositoryUri,
      exportName: `${config.stackPrefix}-EmailIntelRepoUri`,
    });

    new CfnOutput(this, "GitHubDeployRoleArn", {
      value: this.deployRole.roleArn,
      exportName: `${config.stackPrefix}-DeployRoleArn`,
    });

    Tags.of(this).add("skout:environment", config.name);
  }
}
