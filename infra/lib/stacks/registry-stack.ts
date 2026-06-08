import * as ecr from "aws-cdk-lib/aws-ecr";
import * as iam from "aws-cdk-lib/aws-iam";
import { Stack, StackProps, CfnOutput, RemovalPolicy, Tags } from "aws-cdk-lib";
import { Construct } from "constructs";
import type { EnvironmentConfig } from "../config/environments.js";

export interface RegistryStackProps extends StackProps {
  readonly config: EnvironmentConfig;
}

export class RegistryStack extends Stack {
  readonly apiRepository: ecr.Repository;
  readonly aiRepository: ecr.Repository;
  readonly webRepository: ecr.Repository;
  readonly deployRole: iam.Role;

  constructor(scope: Construct, id: string, props: RegistryStackProps) {
    super(scope, id, props);

    const { config } = props;

    const removalPolicy = config.name === "prod" ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY;

    this.apiRepository = new ecr.Repository(this, "ApiRepo", {
      repositoryName: `skout-${config.name}-api`,
      removalPolicy,
      emptyOnDelete: config.name !== "prod",
      imageScanOnPush: true,
    });

    this.aiRepository = new ecr.Repository(this, "AiRepo", {
      repositoryName: `skout-${config.name}-ai`,
      removalPolicy,
      emptyOnDelete: config.name !== "prod",
      imageScanOnPush: true,
    });

    this.webRepository = new ecr.Repository(this, "WebRepo", {
      repositoryName: `skout-${config.name}-web`,
      removalPolicy,
      emptyOnDelete: config.name !== "prod",
      imageScanOnPush: true,
    });

    const githubOrg = config.github?.org ?? "skout-ai";

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
            "token.actions.githubusercontent.com:sub": `repo:${githubOrg}/*`,
          },
        },
        "sts:AssumeRoleWithWebIdentity"
      ),
      description: `GitHub Actions deploy role for Skout ${config.name}`,
    });

    this.apiRepository.grantPullPush(this.deployRole);
    this.aiRepository.grantPullPush(this.deployRole);
    this.webRepository.grantPullPush(this.deployRole);

    this.deployRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ["ecs:UpdateService", "ecs:DescribeServices", "ecs:DescribeTaskDefinition"],
        resources: ["*"],
      })
    );

    new CfnOutput(this, "ApiRepositoryUri", {
      value: this.apiRepository.repositoryUri,
      exportName: `${config.stackPrefix}-ApiRepoUri`,
    });

    new CfnOutput(this, "AiRepositoryUri", {
      value: this.aiRepository.repositoryUri,
      exportName: `${config.stackPrefix}-AiRepoUri`,
    });

    new CfnOutput(this, "WebRepositoryUri", {
      value: this.webRepository.repositoryUri,
      exportName: `${config.stackPrefix}-WebRepoUri`,
    });

    new CfnOutput(this, "GitHubDeployRoleArn", {
      value: this.deployRole.roleArn,
      exportName: `${config.stackPrefix}-DeployRoleArn`,
    });

    Tags.of(this).add("skout:environment", config.name);
  }
}
