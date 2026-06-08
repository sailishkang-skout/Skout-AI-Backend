import { Stack, StackProps, CfnOutput } from "aws-cdk-lib";
import { Construct } from "constructs";
import type { EnvironmentConfig } from "../config/environments.js";

/**
 * Local environment stack — does NOT provision AWS resources.
 * Synthesizes reference outputs for docker-compose and .env generation.
 */
export class LocalConfigStack extends Stack {
  constructor(scope: Construct, id: string, props: StackProps & { config: EnvironmentConfig }) {
    super(scope, id, props);

    const { config } = props;

    new CfnOutput(this, "Environment", { value: config.name });
    new CfnOutput(this, "ApiUrl", { value: "http://localhost:3001" });
    new CfnOutput(this, "WebUrl", { value: "http://localhost:3000" });
    new CfnOutput(this, "AiUrl", { value: "http://localhost:8000" });
    new CfnOutput(this, "DatabaseUrl", { value: "postgresql://skout:skout@localhost:5432/skout" });
    new CfnOutput(this, "RedisUrl", { value: "redis://localhost:6379" });
    new CfnOutput(this, "CorsOrigin", { value: "http://localhost:3000" });
    new CfnOutput(this, "DockerComposeBackend", {
      value: "docker compose -f docker-compose.yml -f docker-compose.local.yml up --build",
    });
    new CfnOutput(this, "DockerComposeFrontend", {
      value:
        "cd ../Skout\\ Ai\\ Frontend && docker compose -f docker-compose.yml -f docker-compose.local.yml up --build",
    });
  }
}
