import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import { SecretValue } from "aws-cdk-lib";
import { Construct } from "constructs";
import type { EnvironmentConfig } from "../config/environments.js";

export interface SkoutAppSecretsProps {
  readonly config: EnvironmentConfig;
  /** When true, import `openai` by name (dev migration from prior stack). */
  readonly importOpenAi?: boolean;
}

/**
 * Application secrets. `openai` is imported when it already exists from a prior deploy;
 * all other secrets are created with placeholder values.
 */
export class SkoutAppSecrets extends Construct {
  readonly openai: secretsmanager.ISecret;
  readonly clerk: secretsmanager.ISecret;
  readonly apollo: secretsmanager.ISecret;
  readonly hunter: secretsmanager.ISecret;
  readonly hubspot: secretsmanager.ISecret;
  readonly opensearch: secretsmanager.ISecret;
  readonly clickhouse: secretsmanager.ISecret;
  readonly scraperLinkedin: secretsmanager.ISecret;
  readonly scraperProxy: secretsmanager.ISecret;
  readonly sentry: secretsmanager.ISecret;
  readonly posthog: secretsmanager.ISecret;

  constructor(scope: Construct, id: string, props: SkoutAppSecretsProps) {
    super(scope, id);

    const prefix = props.config.stackPrefix;

    const createPlaceholder = (constructId: string, secretPath: string, fields: Record<string, string>) =>
      new secretsmanager.Secret(this, constructId, {
        secretName: `${prefix}/${secretPath}`,
        description: `Skout ${props.config.name} — ${secretPath} (replace after deploy)`,
        secretStringValue: SecretValue.unsafePlainText(JSON.stringify(fields)),
      });

    this.openai = props.importOpenAi
      ? secretsmanager.Secret.fromSecretNameV2(this, "OpenAi", `${prefix}/openai`)
      : createPlaceholder("OpenAi", "openai", { OPENAI_API_KEY: "replace-me" });
    this.clerk = createPlaceholder("Clerk", "clerk", {
      CLERK_SECRET_KEY: "replace-me",
      CLERK_PUBLISHABLE_KEY: "replace-me",
    });
    this.apollo = createPlaceholder("Apollo", "apollo", { APOLLO_API_KEY: "replace-me" });
    this.hunter = createPlaceholder("Hunter", "hunter", { HUNTER_API_KEY: "replace-me" });
    this.hubspot = createPlaceholder("Hubspot", "hubspot", {
      HUBSPOT_CLIENT_ID: "replace-me",
      HUBSPOT_CLIENT_SECRET: "replace-me",
    });
    this.opensearch = createPlaceholder("OpenSearch", "opensearch", {
      OPENSEARCH_URL: "replace-me",
      OPENSEARCH_USERNAME: "replace-me",
      OPENSEARCH_PASSWORD: "replace-me",
    });
    this.clickhouse = createPlaceholder("ClickHouse", "clickhouse", { CLICKHOUSE_URL: "replace-me" });
    this.scraperLinkedin = createPlaceholder("ScraperLinkedin", "scraper/linkedin", {
      accounts: "[]",
    });
    this.scraperProxy = createPlaceholder("ScraperProxy", "scraper/proxy", {
      PROXY_URL: "replace-me",
      PROXY_USERNAME: "replace-me",
      PROXY_PASSWORD: "replace-me",
    });
    this.sentry = createPlaceholder("Sentry", "sentry", { SENTRY_DSN: "replace-me" });
    this.posthog = createPlaceholder("PostHog", "posthog", { POSTHOG_API_KEY: "replace-me" });
  }
}
