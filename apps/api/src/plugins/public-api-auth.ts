import { BlockList, isIP } from "node:net";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { and, eq } from "drizzle-orm";
import { schema } from "@skout/db";
import { isPublicApiPath, PUBLIC_API_PREFIX } from "../routes/public-api.routes.js";
import { publicApiError, publicRequestId, type PublicApiErrorCode } from "../public-api/errors.js";
import { verifyPublicApiKey, type ApiKeyType } from "../services/public-api-keys.service.js";
import { subscriptionAccessBlock } from "../services/cops-subscription-access.js";
import { getRedis, isRedisAvailable } from "../lib/redis.js";
import { createMemoryFailedAuthLimiter, createRedisFailedAuthLimiter, type FailedAuthLimiter } from "../lib/failed-auth-limiter.js";

declare module "fastify" {
  interface FastifyRequest {
    /** Set on /api/public/v1 requests authenticated with a public API key (PAPI-024). */
    publicApiKey?: {
      id: string;
      workspaceId: string;
      type: ApiKeyType;
      scopes: string[];
      dailyCreditCap: number | null;
      monthlyCreditCap: number | null;
    };
  }
}

/** Anything that looks like a public API key, wherever it appears (CONV-1, PRD §9.1 log redaction). */
export const PUBLIC_KEY_PATTERN = /sk_(?:live|test)_[A-Za-z0-9_-]+/;

/** Paths on the public prefix that need no key. */
const UNAUTHENTICATED_PUBLIC_PATHS = new Set([`${PUBLIC_API_PREFIX}/health`]);

/** Last-used is written at most once a minute per key, off the request path. */
const LAST_USED_WRITE_INTERVAL_MS = 60_000;

function bearer(request: FastifyRequest): string | undefined {
  const h = request.headers.authorization;
  return typeof h === "string" && h.startsWith("Bearer ") ? h.slice(7).trim() : undefined;
}

export function looksLikePublicKey(token: string | undefined): boolean {
  return Boolean(token && /^sk_(?:live|test)_/.test(token));
}

/** True when the client IP is in the key's allowlist (IPv4/IPv6 addresses and CIDR blocks). Empty = any IP. */
export function ipAllowed(ip: string, allowlist: string[]): boolean {
  if (allowlist.length === 0) return true;
  const addr = ip.startsWith("::ffff:") && isIP(ip.slice(7)) === 4 ? ip.slice(7) : ip;
  const family = isIP(addr);
  if (!family) return false;
  const list = new BlockList();
  for (const entry of allowlist) {
    const [base, bits] = entry.split("/");
    const type = isIP(base ?? "") === 6 ? "ipv6" : "ipv4";
    try {
      if (bits === undefined) list.addAddress(base!, type);
      else list.addSubnet(base!, Number(bits), type);
    } catch {
      // a malformed entry never widens access
    }
  }
  return list.check(addr, family === 6 ? "ipv6" : "ipv4");
}

function fail(reply: FastifyReply, request: FastifyRequest, code: PublicApiErrorCode, message: string) {
  request.publicErrorCode = code;
  const { status, body } = publicApiError(code, message, publicRequestId(request.id));
  return reply.code(status).header("cache-control", "no-store").send(body);
}

export interface PublicApiAuthOptions {
  /** Failed-auth limiter (PAPI-025); by default Redis when reachable, else per-process memory. */
  limiter?: FailedAuthLimiter;
}

function defaultLimiter(app: FastifyInstance): () => Promise<FailedAuthLimiter> {
  let made: Promise<FailedAuthLimiter> | null = null;
  const limits = {
    perMinute: app.config.PUBLIC_API_FAILED_AUTH_PER_MINUTE ?? 20,
    blockMinutes: app.config.PUBLIC_API_FAILED_AUTH_BLOCK_MINUTES ?? 15,
  };
  return () =>
    (made ??= (async () => {
      const redis = app.config.REDIS_URL && (await isRedisAvailable(app.config)) ? getRedis(app.config) : null;
      return redis ? createRedisFailedAuthLimiter(redis, limits) : createMemoryFailedAuthLimiter(limits);
    })());
}

/**
 * PAPI-024 (public API PRD §9.1, §9.2, KEY-11, ADD-5). An onRequest hook, registered in the auth plugin:
 * - A public key (sk_live_/sk_test_) anywhere outside /api/public is refused with 401, on every
 *   route, so an internal route can never become reachable with one.
 * - On /api/public/v1 the only credential is the public key in the Authorization header. Cookies,
 *   app JWTs and CustomerOps keys are not accepted, and a key in the query string is refused.
 * - The key must verify (cached, PAPI-023), and then: the client IP must be in its allowlist, the
 *   workspace must have the add-on and not be suspended, and the member who created it must still
 *   belong to the workspace.
 * The workspace comes only from the key (§9.2). Failed authentications are counted per IP and an IP
 * over the limit gets 429 on the public path for the block period (PAPI-025).
 */
export function registerPublicApiAuth(app: FastifyInstance, opts: PublicApiAuthOptions = {}): void {
  const lastUsedWritten = new Map<string, number>();
  const getLimiter = opts.limiter ? async () => opts.limiter! : defaultLimiter(app);

  // onRequest: before body parsing and schema validation, so no route can answer first.
  app.addHook("onRequest", async (request, reply) => {
    const token = bearer(request);
    const onPublicPath = isPublicApiPath(request.url);

    if (!onPublicPath) {
      if (looksLikePublicKey(token)) {
        return reply.code(401).send({
          error: "unauthorized",
          code: "public_key_not_allowed",
          message: "Public API keys only work on /api/public/v1.",
          statusCode: 401,
        });
      }
      return;
    }

    if (request.method === "OPTIONS") return;
    const pathname = request.url.split("?")[0]!;
    if (UNAUTHENTICATED_PUBLIC_PATHS.has(pathname)) return;

    // PAPI-025 (RL-3): an IP that failed authentication too often is blocked on this path only.
    const limiter = await getLimiter();
    const blockedFor = await limiter.blockedFor(request.ip).catch(() => 0);
    if (blockedFor > 0) {
      reply.header("retry-after", String(blockedFor));
      return fail(reply, request, "rate_limited", "Too many failed authentication attempts from this IP address. Try again later.");
    }
    /** Refuses the request and, for a failed authentication (401), counts it against the IP. */
    const deny = async (code: PublicApiErrorCode, message: string) => {
      if (publicApiError(code, message, "").status === 401) {
        await limiter.recordFailure(request.ip).catch((err: unknown) => app.log.warn({ err }, "could not record failed authentication"));
      }
      return fail(reply, request, code, message);
    };

    const query = request.url.includes("?") ? request.url.slice(request.url.indexOf("?")) : "";
    if (PUBLIC_KEY_PATTERN.test(decodeURIComponent(query))) {
      return deny("authentication_failed", "Send the API key in the Authorization header, never in the URL. Revoke this key.");
    }
    if (!token || !looksLikePublicKey(token)) {
      return deny("authentication_failed", "Send a public API key as: Authorization: Bearer sk_live_...");
    }
    const db = app.db;
    if (!db) return deny("internal_error", "The API is not available.");
    if (!app.config.API_KEY_PEPPER) return deny("internal_error", "The API is not available.");

    const cache = app.publicKeyCache;
    const verified = await verifyPublicApiKey(db, {
      pepper: app.config.API_KEY_PEPPER,
      maxActiveKeys: app.config.PUBLIC_API_MAX_ACTIVE_KEYS,
      lookup: cache ? (prefix) => cache.get(prefix) : undefined,
    }, token);
    if (!verified.ok) {
      const messages = {
        authentication_failed: "The API key is not valid.",
        key_revoked: "This API key has been revoked.",
        key_expired: "This API key has expired. Rotate or create a new one.",
      } as const;
      return deny(verified.error, messages[verified.error]);
    }
    const key = verified.key;

    if (!ipAllowed(request.ip, key.ipAllowlist)) {
      return deny("ip_not_allowed", "Requests from this IP address are not allowed for this key.");
    }

    const addonEnabled =
      verified.addonEnabled ??
      Boolean(
        (
          await db
            .select({ on: schema.workspaceApiSettings.addonEnabled })
            .from(schema.workspaceApiSettings)
            .where(eq(schema.workspaceApiSettings.workspaceId, key.workspaceId))
            .limit(1)
        )[0]?.on
      );
    if (!addonEnabled) return deny("addon_disabled", "The API add-on is not enabled for this workspace.");

    if (await subscriptionAccessBlock(db, key.workspaceId)) {
      return deny("workspace_suspended", "This workspace is suspended. Settle its subscription to use the API.");
    }

    // KEY-11: the key stops working when the member who created it leaves the workspace.
    const [member] = key.createdBy
      ? await db
          .select({ userId: schema.workspaceMembers.userId })
          .from(schema.workspaceMembers)
          .where(and(eq(schema.workspaceMembers.workspaceId, key.workspaceId), eq(schema.workspaceMembers.userId, key.createdBy)))
          .limit(1)
      : [];
    if (!member) return deny("key_revoked", "This API key stopped working because its creator left the workspace.");

    request.publicApiKey = {
      id: key.id,
      workspaceId: key.workspaceId,
      type: key.type as ApiKeyType,
      scopes: key.scopes,
      dailyCreditCap: key.dailyCreditCap,
      monthlyCreditCap: key.monthlyCreditCap,
    };
    request.workspaceId = key.workspaceId;

    const now = Date.now();
    if ((lastUsedWritten.get(key.id) ?? 0) + LAST_USED_WRITE_INTERVAL_MS < now) {
      lastUsedWritten.set(key.id, now);
      void db
        .update(schema.apiKeys)
        .set({ lastUsedAt: new Date(now), lastUsedIp: request.ip })
        .where(eq(schema.apiKeys.id, key.id))
        .catch((err: unknown) => app.log.warn({ err }, "could not record API key last use"));
    }
  });
}
