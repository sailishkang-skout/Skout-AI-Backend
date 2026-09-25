import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import { RemovalPolicy, SecretValue, Stack } from "aws-cdk-lib";
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
  /** Clerk session JWT issuer (AUTH-ADI-03). Created directly in Secrets Manager, imported by
   * name — never wired into the `clerk` secret's own field list, since changing that secret's
   * placeholder shape makes CloudFormation re-push the whole SecretString on next deploy and
   * resets the live CLERK_SECRET_KEY/CLERK_PUBLISHABLE_KEY back to "replace-me" (see AUTH-ADI-06,
   * which hit this exact problem with ADMIN_IMPORT_SECRET). */
  readonly clerkIssuer: secretsmanager.ISecret;
  readonly apollo: secretsmanager.ISecret;
  readonly hunter: secretsmanager.ISecret;
  readonly unipile: secretsmanager.ISecret;
  readonly enrichmentProviders: secretsmanager.ISecret;
  readonly hubspot: secretsmanager.ISecret;
  readonly opensearch: secretsmanager.ISecret;
  readonly clickhouse: secretsmanager.ISecret;
  readonly scraperLinkedin: secretsmanager.ISecret;
  readonly scraperProxy: secretsmanager.ISecret;
  readonly sentry: secretsmanager.ISecret;
  readonly posthog: secretsmanager.ISecret;
  readonly appConfig: secretsmanager.ISecret;
  /** Email-Intel → canonical evidence ledger forwarder (§5.3). */
  readonly emailIntelForwarder: secretsmanager.ISecret;
  readonly datadog: secretsmanager.ISecret;
  readonly razorpay: secretsmanager.ISecret;
  /** SES SMTP for transactional mail (invites, OTP). Managed outside CDK after first create. */
  readonly smtp: secretsmanager.ISecret;
  /** Recall.ai meeting-bot creds (R16.2). Created directly in Secrets Manager, imported by name so CDK doesn't fight the real value. */
  readonly meetingBot: secretsmanager.ISecret;
  /** Twilio click-to-call creds (R20.2). Created directly in Secrets Manager, imported by name. */
  readonly twilio: secretsmanager.ISecret;
  /** Telnyx click-to-call + SMS creds. Created directly in Secrets Manager, imported by name. */
  readonly telnyx: secretsmanager.ISecret;
  /** Google OAuth client (Gmail inbox connection + Calendar). Placeholder until a real Google Cloud OAuth client is created. */
  readonly google: secretsmanager.ISecret;
  /** Warm-Up Tool crypto + platform provisioning key (SkoutDev/warmup-tool). */
  readonly warmupTool: secretsmanager.ISecret;
  /**
   * Own-auth signing material (AUTH-ADI-09). AUTH_JWT_PRIVATE_KEY/KID sign access tokens
   * (api only); AUTH_JWT_PUBLIC_KEY_SET verifies them (api/crm/web); AUTH_REFRESH_TOKEN_PEPPER
   * peppers hashed refresh tokens (api only); AUTH_COOKIE_SECRET signs/encrypts the
   * route-handler session cookie (api/web). Generate real values with
   * `pnpm --filter @skout/infra generate-auth-keys` and rotate per
   * docs/secrets-rotation-policy.md — never reuse a value across environments.
   */
  readonly auth: secretsmanager.ISecret;

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
    this.unipile = createPlaceholder("Unipile", "unipile", {
      UNIPILE_DSN: "https://api1.unipile.com:13111",
      UNIPILE_API_KEY: "replace-me",
    });
    // PAL enrichment providers — email verify, firmographics, phone.
    this.enrichmentProviders = createPlaceholder("EnrichmentProviders", "enrichment-providers", {
      MILLIONVERIFIER_API_KEY: "replace-me",
      ZEROBOUNCE_API_KEY: "replace-me",
      NEVERBOUNCE_API_KEY: "replace-me",
      PDL_API_KEY: "replace-me",
      DATAGMA_API_KEY: "replace-me",
      KASPR_API_KEY: "replace-me",
      LUSHA_API_KEY: "replace-me",
      CONTACTOUT_API_KEY: "replace-me",
      REVENUEBASE_API_KEY: "replace-me",
      EXPLORIUM_API_KEY: "replace-me",
      CORESIGNAL_API_KEY: "replace-me",
      COGNISM_API_KEY: "replace-me",
      OPENCORPORATES_API_KEY: "replace-me",
      OPENROUTER_API_KEY: "replace-me",
    });
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
    this.sentry = createPlaceholder("Sentry", "sentry", {
      SENTRY_DSN: "replace-me-node",
      SENTRY_DSN_AI: "replace-me-python",
      SENTRY_DSN_WEB: "replace-me-frontend",
    });
    this.posthog = createPlaceholder("PostHog", "posthog", {
      POSTHOG_API_KEY: "replace-me",
      POSTHOG_HOST: "https://us.i.posthog.com",
      POSTHOG_PROJECT_ID: "replace-me",
    });
    // Dev: imported by complete ARN so CloudFormation can never re-push a placeholder over the
    // live, manually-rotated INTEGRATION_ENCRYPTION_KEY / ADMIN_IMPORT_SECRET (that reset caused a
    // real outage — see the clerkIssuer note below). Other envs stay CDK-managed but RETAIN, and
    // move to this same pattern once their live secret exists and its ARN suffix is known.
    if (props.config.name === "dev") {
      // Compute still imports this export until its own next deploy; CloudFormation refuses to
      // drop an in-use export, so keep it (same name, same ARN value) for one more deploy, then
      // delete these two exportValue calls in a follow-up.
      Stack.of(this).exportValue(
        `arn:aws:secretsmanager:${props.config.region}:${Stack.of(this).account}:secret:${prefix}/app-config-o0LN6V`,
        { name: "SkoutDev-Data:ExportsOutputRefAppSecretsAppConfig118B932242AF5AD8" }
      );
      this.appConfig = secretsmanager.Secret.fromSecretCompleteArn(
        this,
        "AppConfig",
        `arn:aws:secretsmanager:${props.config.region}:${Stack.of(this).account}:secret:${prefix}/app-config-o0LN6V`
      );
    } else {
      const appConfig = createPlaceholder("AppConfig", "app-config", {
        INTEGRATION_ENCRYPTION_KEY: "replace-me",
        INTEGRATION_ENCRYPTION_KEY_PREVIOUS: "",
        ADMIN_IMPORT_SECRET: "replace-me",
      });
      appConfig.applyRemovalPolicy(RemovalPolicy.RETAIN);
      this.appConfig = appConfig;
    }
    /**
     * Email-Intel → Skout canonical Evidence Ledger forwarder (§5.3).
     * Created/rotated by infra/scripts/setup-email-intel-forwarder.sh — import by name
     * so CDK does not overwrite live TOKEN/URL values.
     */
    this.emailIntelForwarder = secretsmanager.Secret.fromSecretNameV2(
      this,
      "EmailIntelForwarder",
      `${prefix}/email-intel-forwarder`
    );
    this.datadog = createPlaceholder("Datadog", "datadog", {
      DD_API_KEY: "replace-me",
      DD_SITE: "us5.datadoghq.com",
    });
    this.razorpay = createPlaceholder("Razorpay", "razorpay", {
      RAZORPAY_KEY_SECRET: "replace-me",
      RAZORPAY_WEBHOOK_SECRET: "replace-me",
    });
    // Created/rotated by infra/scripts/setup-ses-smtp.sh — import by name so CDK does not fight Secrets Manager.
    this.smtp = secretsmanager.Secret.fromSecretNameV2(this, "Smtp", `${prefix}/smtp`);
    // Created directly via `aws secretsmanager create-secret` (see comment on the field above).
    // Must be imported by COMPLETE ARN: fromSecretNameV2 yields a suffix-less ARN, ECS presents that
    // to Secrets Manager, and IAM then denies it against the `name-??????` grant CDK emits — the
    // task fails with AccessDeniedException no matter how long the policy has propagated.
    // The 6-char suffix is fixed for this secret's lifetime; other envs keep the by-name import
    // until their secret exists.
    this.clerkIssuer =
      props.config.name === "dev"
        ? secretsmanager.Secret.fromSecretCompleteArn(
            this,
            "ClerkIssuer",
            `arn:aws:secretsmanager:${props.config.region}:${Stack.of(this).account}:secret:${prefix}/clerk-issuer-fU7g9h`
          )
        : secretsmanager.Secret.fromSecretNameV2(this, "ClerkIssuer", `${prefix}/clerk-issuer`);
    this.meetingBot = secretsmanager.Secret.fromSecretNameV2(this, "MeetingBot", `${prefix}/meeting-bot`);
    this.twilio = secretsmanager.Secret.fromSecretNameV2(this, "Twilio", `${prefix}/twilio`);
    this.telnyx = secretsmanager.Secret.fromSecretNameV2(this, "Telnyx", `${prefix}/telnyx`);
    this.google = createPlaceholder("Google", "google", {
      GOOGLE_CLIENT_ID: "replace-me",
      GOOGLE_CLIENT_SECRET: "replace-me",
    });
    // Generate strong placeholders once; rotate in Secrets Manager after first deploy.
    this.warmupTool = createPlaceholder("WarmupTool", "warmup-tool", {
      ENCRYPTION_KEY: "replace-me-warmup-encryption-key-32chars-min!!",
      API_KEY_PEPPER: "replace-me-warmup-api-key-pepper-32chars-min!",
      PLATFORM_PROVISIONING_KEY: "replace-me-warmup-platform-provision-32!",
    });
    // Placeholder only — replace with real output from
    // `pnpm --filter @skout/infra generate-auth-keys` before AUTH-BE-12 relies on it.
    // Dev: imported by complete ARN (same reason as appConfig) so a field-list change can never
    // wipe the real RS256 key. Other envs stay CDK-managed with RETAIN.
    if (props.config.name === "dev") {
      Stack.of(this).exportValue(
        `arn:aws:secretsmanager:${props.config.region}:${Stack.of(this).account}:secret:${prefix}/auth-axjQL7`,
        { name: "SkoutDev-Data:ExportsOutputRefAppSecretsAuth933E2836EAC0C3D9" }
      );
      this.auth = secretsmanager.Secret.fromSecretCompleteArn(
        this,
        "Auth",
        `arn:aws:secretsmanager:${props.config.region}:${Stack.of(this).account}:secret:${prefix}/auth-axjQL7`
      );
    } else {
      const auth = createPlaceholder("Auth", "auth", {
        AUTH_JWT_PRIVATE_KEY: "replace-me",
        AUTH_JWT_KID: "replace-me",
        AUTH_JWT_PUBLIC_KEY_SET: "replace-me",
        AUTH_REFRESH_TOKEN_PEPPER: "replace-me",
        AUTH_COOKIE_SECRET: "replace-me",
      });
      auth.applyRemovalPolicy(RemovalPolicy.RETAIN);
      this.auth = auth;
    }
  }
}
