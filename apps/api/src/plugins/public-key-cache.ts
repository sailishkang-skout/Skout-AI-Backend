import type { FastifyInstance } from "fastify";
import fp from "fastify-plugin";
import { getRedis, isRedisAvailable } from "../lib/redis.js";
import {
  PublicKeyCache,
  createMemoryInvalidationBus,
  createRedisInvalidationBus,
  clearPublicKeyInvalidator,
  setPublicKeyInvalidator,
  type KeyInvalidation,
} from "../lib/public-key-cache.js";

declare module "fastify" {
  interface FastifyInstance {
    /** PAPI-023: cached public API key lookups; null without a database. */
    publicKeyCache: PublicKeyCache | null;
  }
}

/**
 * PAPI-023: one key cache per instance. With Redis, keys are also cached there and invalidations go
 * over Redis pub/sub to every instance; without Redis (local dev, CI) the cache is per process.
 */
export const publicKeyCachePlugin = fp(async (app: FastifyInstance) => {
  if (!app.db) {
    app.decorate("publicKeyCache", null);
    return;
  }
  const useRedis = Boolean(app.config.REDIS_URL) && (await isRedisAvailable(app.config));
  const bus = useRedis ? createRedisInvalidationBus(app.config.REDIS_URL!) : createMemoryInvalidationBus();
  const cache = new PublicKeyCache(app.db, { bus, redis: useRedis ? getRedis(app.config) : null });
  await cache.start();
  const invalidate = (msg: KeyInvalidation) => cache.invalidate(msg);
  setPublicKeyInvalidator(invalidate);
  app.decorate("publicKeyCache", cache);
  app.addHook("onClose", async () => {
    clearPublicKeyInvalidator(invalidate);
    await cache.stop();
  });
});
