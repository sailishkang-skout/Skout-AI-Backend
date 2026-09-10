import * as ec2 from "aws-cdk-lib/aws-ec2";
import { Stack, StackProps, Tags } from "aws-cdk-lib";
import { Construct } from "constructs";
import type { EnvironmentConfig } from "../config/environments.js";

export interface NetworkStackProps extends StackProps {
  readonly config: EnvironmentConfig;
}

export class NetworkStack extends Stack {
  readonly vpc: ec2.Vpc;

  constructor(scope: Construct, id: string, props: NetworkStackProps) {
    super(scope, id, props);

    const { config } = props;

    this.vpc = new ec2.Vpc(this, "Vpc", {
      maxAzs: config.vpc.maxAzs,
      natGateways: config.vpc.natGateways,
      subnetConfiguration: [
        { name: "Public", subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 },
        { name: "Private", subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS, cidrMask: 24 },
      ],
    });

    Tags.of(this).add("skout:environment", config.name);
    Tags.of(this).add("skout:managed-by", "cdk");
  }
}
