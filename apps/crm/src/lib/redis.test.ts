import { describe, expect, it } from "vitest";
import { redisBullMqConnection } from "./redis.js";

describe("redisBullMqConnection", () => {
  it("parses host, port, and password from a redis:// URL", () => {
    expect(redisBullMqConnection("redis://:secret@my-redis-host:6380")).toEqual({
      host: "my-redis-host",
      port: 6380,
      password: "secret",
    });
  });

  it("defaults to port 6379 when the URL omits one", () => {
    const conn = redisBullMqConnection("redis://localhost");
    expect(conn.port).toBe(6379);
  });

  it("leaves password undefined when the URL has none", () => {
    const conn = redisBullMqConnection("redis://localhost:6379");
    expect(conn.password).toBeUndefined();
  });

  it("enables TLS for a rediss:// URL", () => {
    const conn = redisBullMqConnection("rediss://my-redis-host:6380");
    expect(conn).toMatchObject({ host: "my-redis-host", port: 6380, tls: {} });
  });

  it("does not set tls for a plain redis:// URL", () => {
    const conn = redisBullMqConnection("redis://localhost:6379");
    expect(conn).not.toHaveProperty("tls");
  });
});
