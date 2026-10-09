import { describe, expect, it } from "vitest";
import type { Env } from "../config/env.js";
import {
  AwsHubSpotCredentialsStore,
  InlineEncryptedHubSpotCredentialsStore,
  LocalHubSpotCredentialsStore,
  createHubSpotCredentialsStore,
} from "./hubspot-credentials.store.js";

const tokens = {
  accessToken: "access-token-value",
  refreshToken: "refresh-token-value",
  expiresAt: new Date(1_900_000_000_000).toISOString(),
};

const cfg = (over: Record<string, unknown> = {}) =>
  ({ NODE_ENV: "test", INTEGRATION_ENCRYPTION_KEY: "key-one-0123456789abcdef", ...over }) as unknown as Env;

describe("InlineEncryptedHubSpotCredentialsStore", () => {
  it("round-trips tokens and never exposes them in the ref", async () => {
    const store = new InlineEncryptedHubSpotCredentialsStore(cfg());
    const ref = await store.save("ws-1", tokens);

    expect(ref.startsWith("enc:v1:")).toBe(true);
    expect(ref).not.toContain(tokens.accessToken);
    expect(ref).not.toContain(tokens.refreshToken);
    expect(await store.load(ref)).toEqual(tokens);
  });

  it("produces a new ref per save (fresh IV) so the caller must persist the returned ref", async () => {
    const store = new InlineEncryptedHubSpotCredentialsStore(cfg());
    const a = await store.save("ws-1", tokens);
    const b = await store.save("ws-1", tokens);
    expect(a).not.toBe(b);
  });

  it("still loads refs written under the previous key during key rotation", async () => {
    const oldStore = new InlineEncryptedHubSpotCredentialsStore(cfg({ INTEGRATION_ENCRYPTION_KEY: "old-key-0123456789abcdef" }));
    const ref = await oldStore.save("ws-1", tokens);

    const rotated = new InlineEncryptedHubSpotCredentialsStore(
      cfg({
        INTEGRATION_ENCRYPTION_KEY: "new-key-0123456789abcdef",
        INTEGRATION_ENCRYPTION_KEY_PREVIOUS: "old-key-0123456789abcdef",
      })
    );
    expect(await rotated.load(ref)).toEqual(tokens);
  });

  it("returns null for foreign refs, tampered ciphertext, and refs under an unknown key", async () => {
    const store = new InlineEncryptedHubSpotCredentialsStore(cfg());
    const ref = await store.save("ws-1", tokens);

    expect(await store.load("SkoutDev/crm/ws-1/hubspot")).toBeNull();
    expect(await store.load("local:ws-1:hubspot")).toBeNull();
    expect(await store.load(ref.slice(0, -4) + "AAAA")).toBeNull();

    const other = new InlineEncryptedHubSpotCredentialsStore(cfg({ INTEGRATION_ENCRYPTION_KEY: "other-key-0123456789abcdef" }));
    expect(await other.load(ref)).toBeNull();
  });

  it("delete is a no-op because the ciphertext lives in the connection row", async () => {
    const store = new InlineEncryptedHubSpotCredentialsStore(cfg());
    await expect(store.delete("enc:v1:anything")).resolves.toBeUndefined();
  });

  it("refuses to run in production without a real INTEGRATION_ENCRYPTION_KEY", () => {
    expect(
      () => new InlineEncryptedHubSpotCredentialsStore(cfg({ NODE_ENV: "production", INTEGRATION_ENCRYPTION_KEY: undefined }))
    ).toThrow(/INTEGRATION_ENCRYPTION_KEY/);
  });
});

describe("createHubSpotCredentialsStore", () => {
  it("keeps AWS Secrets Manager as the default so the existing deployment is unchanged", () => {
    expect(createHubSpotCredentialsStore(cfg())).toBeInstanceOf(AwsHubSpotCredentialsStore);
  });

  it("selects the inline store with CRM_CREDENTIALS_BACKEND=inline", () => {
    expect(createHubSpotCredentialsStore(cfg({ CRM_CREDENTIALS_BACKEND: "inline" }))).toBeInstanceOf(
      InlineEncryptedHubSpotCredentialsStore
    );
  });

  it("lets the local-dev flag win over the backend setting", () => {
    expect(
      createHubSpotCredentialsStore(cfg({ CRM_CREDENTIALS_LOCAL: true, CRM_CREDENTIALS_BACKEND: "inline" }))
    ).toBeInstanceOf(LocalHubSpotCredentialsStore);
  });
});
