import { describe, it, expect, beforeEach } from "vitest";
import { getIntegrationEncryptionSecret, getHubSpotOAuthSecret } from "./encryption-secrets.js";
import type { Env } from "../config/env.js";

// Create a base mock Env object that we can modify in tests
const createMockEnv = (overrides: Partial<Env> = {}): Env => ({
  NODE_ENV: "development",
  INTEGRATION_ENCRYPTION_KEY: undefined,
  HUBSPOT_CLIENT_SECRET: undefined,
  // Add other required Env properties with default values
  PORT: 3000,
  DATABASE_URL: "postgresql://localhost/test",
  CLERK_SECRET_KEY: undefined,
  CLERK_JWT_ISSUER: undefined,
  CORS_ORIGIN: "http://localhost:3000",
  FRONTEND_URL: "http://localhost:3000",
  ...overrides,
} as Env);

describe("encryption-secrets utilities", () => {
  describe("getIntegrationEncryptionSecret", () => {
    it("returns the provided INTEGRATION_ENCRYPTION_KEY when it's a valid configured secret", () => {
      const validKey = "valid-encryption-key-123456789";
      const config = createMockEnv({ INTEGRATION_ENCRYPTION_KEY: validKey });
      
      const result = getIntegrationEncryptionSecret(config);
      expect(result).toBe(validKey);
    });

    it("returns the development fallback when INTEGRATION_ENCRYPTION_KEY is undefined in non-production", () => {
      const config = createMockEnv({ INTEGRATION_ENCRYPTION_KEY: undefined });
      
      const result = getIntegrationEncryptionSecret(config);
      expect(result).toBe("dev-integration-encryption-key-change-me");
    });

    it("returns the development fallback when INTEGRATION_ENCRYPTION_KEY is a placeholder in non-production", () => {
      const config = createMockEnv({ INTEGRATION_ENCRYPTION_KEY: "replace-me" });
      
      const result = getIntegrationEncryptionSecret(config);
      expect(result).toBe("dev-integration-encryption-key-change-me");
    });

    it("throws an error in production when INTEGRATION_ENCRYPTION_KEY is undefined", () => {
      const config = createMockEnv({
        NODE_ENV: "production",
        INTEGRATION_ENCRYPTION_KEY: undefined,
      });
      
      expect(() => getIntegrationEncryptionSecret(config)).toThrow(
        "INTEGRATION_ENCRYPTION_KEY must be set to a valid non-placeholder value in production."
      );
    });

    it("throws an error in production when INTEGRATION_ENCRYPTION_KEY is a placeholder", () => {
      const config = createMockEnv({
        NODE_ENV: "production",
        INTEGRATION_ENCRYPTION_KEY: "replace-me",
      });
      
      expect(() => getIntegrationEncryptionSecret(config)).toThrow(
        "INTEGRATION_ENCRYPTION_KEY must be set to a valid non-placeholder value in production."
      );
    });

    it("returns the provided INTEGRATION_ENCRYPTION_KEY when it's valid in production", () => {
      const validKey = "valid-production-key-123456789";
      const config = createMockEnv({
        NODE_ENV: "production",
        INTEGRATION_ENCRYPTION_KEY: validKey,
      });
      
      const result = getIntegrationEncryptionSecret(config);
      expect(result).toBe(validKey);
    });
  });

  describe("getHubSpotOAuthSecret", () => {
    it("returns the provided HUBSPOT_CLIENT_SECRET when it's a valid configured secret", () => {
      const validSecret = "valid-hubspot-secret-123456789";
      const config = createMockEnv({ HUBSPOT_CLIENT_SECRET: validSecret });
      
      const result = getHubSpotOAuthSecret(config);
      expect(result).toBe(validSecret);
    });

    it("returns the development fallback when HUBSPOT_CLIENT_SECRET is undefined in non-production", () => {
      const config = createMockEnv({ HUBSPOT_CLIENT_SECRET: undefined });
      
      const result = getHubSpotOAuthSecret(config);
      expect(result).toBe("dev-oauth-state");
    });

    it("returns the development fallback when HUBSPOT_CLIENT_SECRET is a placeholder in non-production", () => {
      const config = createMockEnv({ HUBSPOT_CLIENT_SECRET: "replace-me" });
      
      const result = getHubSpotOAuthSecret(config);
      expect(result).toBe("dev-oauth-state");
    });

    it("throws an error in production when HUBSPOT_CLIENT_SECRET is undefined", () => {
      const config = createMockEnv({
        NODE_ENV: "production",
        HUBSPOT_CLIENT_SECRET: undefined,
      });
      
      expect(() => getHubSpotOAuthSecret(config)).toThrow(
        "HUBSPOT_CLIENT_SECRET must be set to a valid non-placeholder value in production."
      );
    });

    it("throws an error in production when HUBSPOT_CLIENT_SECRET is a placeholder", () => {
      const config = createMockEnv({
        NODE_ENV: "production",
        HUBSPOT_CLIENT_SECRET: "replace-me",
      });
      
      expect(() => getHubSpotOAuthSecret(config)).toThrow(
        "HUBSPOT_CLIENT_SECRET must be set to a valid non-placeholder value in production."
      );
    });

    it("returns the provided HUBSPOT_CLIENT_SECRET when it's valid in production", () => {
      const validSecret = "valid-production-hubspot-secret";
      const config = createMockEnv({
        NODE_ENV: "production",
        HUBSPOT_CLIENT_SECRET: validSecret,
      });
      
      const result = getHubSpotOAuthSecret(config);
      expect(result).toBe(validSecret);
    });
  });

  // Verify dual-read key rotation behavior is preserved (INTEGRATION_ENCRYPTION_KEY_PREVIOUS)
  it("maintains dual-read key rotation functionality in consuming services", async () => {
    const { decryptSecretWithFallback, encryptSecret } = await import("@skout/shared");
    
    const currentKey = "current-encryption-key-123456789";
    const previousKey = "previous-encryption-key-987654321";
    const secretData = "sensitive-api-key-abc123";

    // Encrypt with current key
    const encrypted = encryptSecret(secretData, currentKey);
    
    // Decrypt with both keys (simulates decryptSecretWithFallback behavior)
    const decryptedWithCurrent = decryptSecretWithFallback(encrypted, currentKey, previousKey);
    expect(decryptedWithCurrent).toBe(secretData);
    
    // Also verify we can decrypt with previous key if that's what encrypted the data
    const encryptedWithPrevious = encryptSecret(secretData, previousKey);
    const decryptedWithPrevious = decryptSecretWithFallback(encryptedWithPrevious, currentKey, previousKey);
    expect(decryptedWithPrevious).toBe(secretData);
  });

  // Verify that CLERK_SECRET_KEY is never used as a fallback (our primary task)
  it("never uses CLERK_SECRET_KEY as a fallback for encryption secrets", () => {
    const clerkKey = "sk_test_clerk-secret-key-123";
    const config = createMockEnv({
      INTEGRATION_ENCRYPTION_KEY: undefined,
      HUBSPOT_CLIENT_SECRET: undefined,
      CLERK_SECRET_KEY: clerkKey,
    });
    
    const integrationKey = getIntegrationEncryptionSecret(config);
    const hubspotKey = getHubSpotOAuthSecret(config);
    
    // Verify we don't use CLERK_SECRET_KEY - we should return dev fallbacks instead
    expect(integrationKey).not.toBe(clerkKey);
    expect(hubspotKey).not.toBe(clerkKey);
    expect(integrationKey).toBe("dev-integration-encryption-key-change-me");
    expect(hubspotKey).toBe("dev-oauth-state");
  });
});