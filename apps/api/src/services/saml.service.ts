import type { FastifyInstance } from "fastify";
import { SAML, type SamlConfig, ValidateInResponseTo } from "@node-saml/node-saml";
import { and, eq } from "drizzle-orm";
import type { Db } from "@skout/db";
import { schema } from "@skout/db";
import { resolveOrProvisionUser } from "@skout/auth";
import { revokeAllSessionsForUser } from "./session.service.js";
import { getRedis } from "../lib/redis.js";
import type { Env } from "../config/env.js";
import { HttpError } from "../utils/http.js";
import { Parser } from "xml2js";
import * as followRedirects from "follow-redirects";
const { https } = followRedirects;

const { workspaceSsoConfigs, users, workspaceMembers, authSessions } = schema;

// Replay cache constants - store InResponseTo values for 5 minutes (longer than assertion validity)
const REPLAY_CACHE_TTL = 300; // 5 minutes in seconds

export async function fetchIdpMetadata(metadataUrl: string): Promise<string> {
  return new Promise((resolve, reject) => {
    https.get(metadataUrl, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => resolve(data));
      res.on("error", reject);
    }).on("error", reject);
  });
}

export async function parseIdpMetadata(xml: string): Promise<any> {
  const parser = new Parser();
  return new Promise((resolve, reject) => {
    parser.parseString(xml, (err, result) => {
      if (err) reject(err);
      else resolve(result);
    });
  });
}

export async function validateSamlAssertion(
  app: FastifyInstance,
  workspaceId: string,
  samlResponse: string,
  inResponseTo: string
): Promise<{ userId: string; userEmail: string; workspaceId: string; role: string }> {
  const db = app.db as Db;
  const config = app.config as Env;

  // Get workspace SSO config
  const [ssoConfig] = await db
    .select()
    .from(workspaceSsoConfigs)
    .where(eq(workspaceSsoConfigs.workspaceId, workspaceId))
    .limit(1);

  if (!ssoConfig || ssoConfig.status !== "active") {
    throw new HttpError("SSO not configured or not active for this workspace", 400);
  }

  if (!ssoConfig.idpMetadataUrl) {
    throw new HttpError("IdP metadata URL not configured", 400);
  }

  // Check replay cache to prevent assertion reuse
  const redis = getRedis(config);
  const replayKey = `saml:replay:${workspaceId}:${inResponseTo}`;
  if (redis && inResponseTo && typeof inResponseTo === 'string' && inResponseTo.length > 0) {
    try {
      const exists = await redis.exists(replayKey);
      if (exists) {
        throw new HttpError("SAML assertion already used (replay detected)", 400);
      }
    } catch (err) {
      // Fail open if Redis is unavailable, but log the error
      app.log.error({ err, workspaceId, inResponseTo }, "Redis replay check failed");
    }
  }

  // Fetch and parse IdP metadata to get signing certificate
  const metadataXml = await fetchIdpMetadata(ssoConfig.idpMetadataUrl);
  const metadata = await parseIdpMetadata(metadataXml);
  
  const idpSsoDescriptor = metadata.EntityDescriptor?.IDPSSODescriptor?.[0]; // cspell:ignore IDPSSODescriptor
  const cert = idpSsoDescriptor?.KeyDescriptor?.[0]?.KeyInfo?.[0]?.X509Data?.[0]?.X509Certificate?.[0];
  
  if (!cert) {
    throw new HttpError("Failed to extract signing certificate from IdP metadata", 500);
  }

  // Configure SAML service
  const samlConfig: SamlConfig = {
      issuer: config.SAML_ISSUER || "https://app.skout.com",
      entryPoint: idpSsoDescriptor?.SingleSignOnService?.[0]?.$.Location,
      idpCert: cert,
      audience: config.SAML_AUDIENCE || "https://app.skout.com",
      callbackUrl: `${config.API_URL || "https://app.skout.com"}/api/v1/saml/acs`,
      validateInResponseTo: ValidateInResponseTo.always,
      wantAssertionsSigned: true,
    };

  const samlService = new SAML(samlConfig);

  // Validate the SAML response
  const profile = await samlService.validatePostResponseAsync({ 
          SAMLResponse: samlResponse, 
          RelayState: workspaceId 
        });

  // After successful validation, add to replay cache
  if (redis && inResponseTo && typeof inResponseTo === 'string' && inResponseTo.length > 0) {
    await redis.setex(replayKey, REPLAY_CACHE_TTL, "1"); // cspell:ignore setex
  }

  // @ts-ignore - profile type has the necessary fields
  const { email, displayName, groups } = profile;
  
  if (!email) {
    throw new HttpError("SAML assertion missing required email attribute", 400);
  }

  // Map IdP groups to workspace role using group_role_map from SSO config
  const groupRoleMap = ssoConfig.groupRoleMap as Record<string, string>;
  let role = "member"; // default role
  
  if (groups && Array.isArray(groups)) {
    for (const group of groups) {
      if (groupRoleMap[group]) {
        role = groupRoleMap[group];
        break; // take the first matching role (highest privilege should come first)
      }
    }
  }

  // JIT provision the user using existing resolveOrProvisionUser
  const provider = `saml:${ssoConfig.idpProvider}`;
  const result = await resolveOrProvisionUser(db, {
    provider,
    subject: inResponseTo, // or the NameID from the assertion
    email,
    name: displayName || email,
    emailVerified: true,
  });

  // Update the user's role in the workspace if it changed
  const [existingMembership] = await db
    .select({ role: workspaceMembers.role })
    .from(workspaceMembers)
    .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, result.userId)))
    .limit(1);

  if (!existingMembership) {
    await db.insert(workspaceMembers).values({ workspaceId, userId: result.userId, role });
  } else if (existingMembership.role !== role) {
    await db
      .update(workspaceMembers)
      .set({ role })
      .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, result.userId)));
  }

  return { ...result, role };
}

export async function deprovisionUser(
  db: Db,
  config: Env,
  userId: string,
  workspaceId: string
): Promise<void> {
  // Mark user as blocked in the users table
  await db
    .update(users)
    .set({ isBlocked: true, status: "inactive", updatedAt: new Date() })
    .where(eq(users.id, userId));

  // Remove them from the workspace
  await db
    .delete(workspaceMembers)
    .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, userId)));

  // Revoke all their sessions
  await revokeAllSessionsForUser(db, config, userId, "blocked");
}

export async function registerSamlRoutes(app: FastifyInstance) {
  // SAML ACS endpoint - receives SAML responses from IdP
  app.post("/api/v1/saml/acs", async (request, reply) => {
    const { SAMLResponse, RelayState, InResponseTo } = request.body as {
      SAMLResponse: string;
      RelayState: string;
      InResponseTo: string;
    };

    if (!SAMLResponse || !RelayState || !InResponseTo) {
      return reply.code(400).send({ error: "Missing required SAML parameters" });
    }

    try {
      const result = await validateSamlAssertion(app, RelayState, SAMLResponse, InResponseTo);
      return reply.send({
        success: true,
        userId: result.userId,
        workspaceId: result.workspaceId,
        role: result.role,
      });
    } catch (err) {
      app.log.error({ error: err }, "SAML assertion validation failed");
      return reply.code(400).send({ error: err instanceof Error ? err.message : "SAML validation failed" });
    }
  });

  // SAML metadata endpoint - exposes our SP metadata to IdPs
  app.get("/api/v1/saml/metadata", async (request, reply) => {
    const config = app.config as Env;
    const issuer = config.SAML_ISSUER || "https://app.skout.com";
    const acsUrl = `${config.API_URL || "https://api.skout.com"}/api/v1/saml/acs`;
    
    // Simple SP metadata XML
    const metadata = `<?xml version="1.0"?>
<md:EntityDescriptor xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata" entityID="${issuer}">
  <md:SPSSODescriptor protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol">
    <md:AssertionConsumerService Location="${acsUrl}" Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST" index="0"/>
  </md:SPSSODescriptor>
</md:EntityDescriptor>`;
    
    reply.type("application/xml").send(metadata);
  });
}