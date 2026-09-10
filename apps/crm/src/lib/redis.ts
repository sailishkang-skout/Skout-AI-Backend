/** BullMQ connection options from REDIS_URL. Mirrors apps/api/src/lib/redis.ts's helper of the
 * same name so both services build identical connection options for the shared queue. */
export function redisBullMqConnection(redisUrl: string) {
  const parsed = new URL(redisUrl);
  return {
    host: parsed.hostname,
    port: Number(parsed.port || "6379"),
    password: parsed.password || undefined,
    ...(parsed.protocol === "rediss:" ? { tls: {} } : {}),
  };
}
