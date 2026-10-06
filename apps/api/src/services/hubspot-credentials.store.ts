import {
  CreateSecretCommand,
  DeleteSecretCommand,
  GetSecretValueCommand,
  PutSecretValueCommand,
  SecretsManagerClient,
} from "@aws-sdk/client-secrets-manager";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { decryptSecretWithFallback, encryptSecret } from "@skout/shared";
import type { Env } from "../config/env.js";
import { getIntegrationEncryptionSecret } from "../utils/encryption-secrets.js";
import type { HubSpotTokens } from "./hubspot.client.js";

export interface HubSpotCredentialsStore {
  buildRef(workspaceId: string): string;
  save(workspaceId: string, tokens: HubSpotTokens): Promise<string>;
  load(credentialsRef: string): Promise<HubSpotTokens | null>;
  delete(credentialsRef: string): Promise<void>;
}

const HUBSPOT_PROVIDER = "hubspot";

function parseTokens(raw: string): HubSpotTokens | null {
  try {
    const data = JSON.parse(raw) as HubSpotTokens;
    if (!data.accessToken || !data.refreshToken) return null;
    return data;
  } catch {
    return null;
  }
}

/** Per-workspace OAuth tokens in AWS Secrets Manager (production). */
export class AwsHubSpotCredentialsStore implements HubSpotCredentialsStore {
  private readonly client: SecretsManagerClient;
  private readonly prefix: string;

  constructor(config: Env) {
    this.client = new SecretsManagerClient({
      region: config.AWS_REGION ?? process.env.AWS_REGION ?? "us-east-1",
    });
    this.prefix = config.CRM_SECRETS_PREFIX ?? "SkoutDev/crm";
  }

  buildRef(workspaceId: string): string {
    return `${this.prefix}/${workspaceId}/${HUBSPOT_PROVIDER}`;
  }

  async save(workspaceId: string, tokens: HubSpotTokens): Promise<string> {
    const secretId = this.buildRef(workspaceId);
    const body = JSON.stringify(tokens);
    try {
      await this.client.send(
        new CreateSecretCommand({
          Name: secretId,
          SecretString: body,
          Description: `Skout HubSpot OAuth tokens for workspace ${workspaceId}`,
        })
      );
    } catch (err: unknown) {
      const name = err && typeof err === "object" && "name" in err ? String(err.name) : "";
      if (name === "ResourceExistsException") {
        await this.client.send(
          new PutSecretValueCommand({ SecretId: secretId, SecretString: body })
        );
      } else {
        throw err;
      }
    }
    return secretId;
  }

  async load(credentialsRef: string): Promise<HubSpotTokens | null> {
    try {
      const res = await this.client.send(
        new GetSecretValueCommand({ SecretId: credentialsRef })
      );
      if (!res.SecretString) return null;
      return parseTokens(res.SecretString);
    } catch {
      return null;
    }
  }

  async delete(credentialsRef: string): Promise<void> {
    try {
      await this.client.send(
        new DeleteSecretCommand({ SecretId: credentialsRef, ForceDeleteWithoutRecovery: true })
      );
    } catch {
      // Secret may already be gone.
    }
  }
}

/** Local dev fallback when AWS is unavailable (gitignored `.crm-secrets/`). */
export class LocalHubSpotCredentialsStore implements HubSpotCredentialsStore {
  private readonly dir: string;

  constructor() {
    this.dir = path.resolve(process.cwd(), ".crm-secrets");
  }

  buildRef(workspaceId: string): string {
    return `local:${workspaceId}:${HUBSPOT_PROVIDER}`;
  }

  private filePath(credentialsRef: string): string {
    const workspaceId = credentialsRef.split(":")[1] ?? credentialsRef;
    return path.join(this.dir, `${workspaceId}-${HUBSPOT_PROVIDER}.json`);
  }

  async save(workspaceId: string, tokens: HubSpotTokens): Promise<string> {
    await mkdir(this.dir, { recursive: true });
    const ref = this.buildRef(workspaceId);
    await writeFile(this.filePath(ref), JSON.stringify(tokens), "utf8");
    return ref;
  }

  async load(credentialsRef: string): Promise<HubSpotTokens | null> {
    try {
      const raw = await readFile(this.filePath(credentialsRef), "utf8");
      return parseTokens(raw);
    } catch {
      return null;
    }
  }

  async delete(credentialsRef: string): Promise<void> {
    try {
      await unlink(this.filePath(credentialsRef));
    } catch {
      // ignore
    }
  }
}

const INLINE_PREFIX = "enc:v1:";

/**
 * Tokens encrypted with INTEGRATION_ENCRYPTION_KEY and carried inside the ref itself, which the
 * caller persists in `crm_connections.credentials_ref`. No external secret store needed.
 * Every save returns a new ref (fresh IV) — callers must persist the returned value, as
 * `saveHubSpotTokens` already does.
 */
export class InlineEncryptedHubSpotCredentialsStore implements HubSpotCredentialsStore {
  private readonly secret: string;
  private readonly previousSecret: string | null;

  constructor(config: Env) {
    this.secret = getIntegrationEncryptionSecret(config);
    this.previousSecret = config.INTEGRATION_ENCRYPTION_KEY_PREVIOUS ?? null;
  }

  buildRef(workspaceId: string): string {
    return `${INLINE_PREFIX}${workspaceId}:${HUBSPOT_PROVIDER}`;
  }

  async save(_workspaceId: string, tokens: HubSpotTokens): Promise<string> {
    return INLINE_PREFIX + encryptSecret(JSON.stringify(tokens), this.secret);
  }

  async load(credentialsRef: string): Promise<HubSpotTokens | null> {
    if (!credentialsRef.startsWith(INLINE_PREFIX)) return null;
    try {
      const raw = decryptSecretWithFallback(
        credentialsRef.slice(INLINE_PREFIX.length),
        this.secret,
        this.previousSecret
      );
      return parseTokens(raw);
    } catch {
      return null;
    }
  }

  async delete(_credentialsRef: string): Promise<void> {
    // Nothing external to remove: the ciphertext lives in the connection row.
  }
}

export function createHubSpotCredentialsStore(config: Env): HubSpotCredentialsStore {
  if (config.CRM_CREDENTIALS_LOCAL === true) {
    return new LocalHubSpotCredentialsStore();
  }
  if (config.CRM_CREDENTIALS_BACKEND === "inline") {
    return new InlineEncryptedHubSpotCredentialsStore(config);
  }
  return new AwsHubSpotCredentialsStore(config);
}
