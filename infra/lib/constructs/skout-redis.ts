import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as elasticache from "aws-cdk-lib/aws-elasticache";
import { RemovalPolicy } from "aws-cdk-lib";
import { Construct } from "constructs";
import type { EnvironmentConfig } from "../config/environments.js";

export interface SkoutRedisProps {
  readonly vpc: ec2.IVpc;
  readonly config: EnvironmentConfig;
}

export class SkoutRedis extends Construct {
  readonly endpoint: string;
  readonly securityGroup: ec2.SecurityGroup;

  constructor(scope: Construct, id: string, props: SkoutRedisProps) {
    super(scope, id);

    const { vpc, config } = props;

    const subnetGroup = new elasticache.CfnSubnetGroup(this, "SubnetGroup", {
      description: "Skout Redis subnets",
      subnetIds: vpc.selectSubnets({ subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS }).subnetIds,
      cacheSubnetGroupName: `${config.stackPrefix}-redis`.toLowerCase(),
    });

    this.securityGroup = new ec2.SecurityGroup(this, "RedisSg", {
      vpc,
      description: "Skout Redis",
      allowAllOutbound: true,
    });

    const cluster = new elasticache.CfnCacheCluster(this, "Redis", {
      engine: "redis",
      cacheNodeType: config.redis.nodeType,
      numCacheNodes: config.redis.numCacheNodes,
      cacheSubnetGroupName: subnetGroup.cacheSubnetGroupName!,
      vpcSecurityGroupIds: [this.securityGroup.securityGroupId],
      clusterName: `${config.stackPrefix}-redis`.toLowerCase(),
    });
    cluster.addDependency(subnetGroup);
    cluster.applyRemovalPolicy(config.name === "prod" ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY);

    this.endpoint = cluster.attrRedisEndpointAddress;
  }
}
