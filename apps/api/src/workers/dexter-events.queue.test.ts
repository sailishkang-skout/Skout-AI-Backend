import { describe, expect, it } from "vitest";
import { connect } from "node:net";
import { createEvent } from "@skout/shared";
import { loadEnv } from "../config/env.js";
import { enqueueDexterEvent } from "./dexter-events.queue.js";

/** Cheap raw-socket probe, independent of anything under test, just to know
 * whether this run's assertions should expect Redis-down behavior. */
function probeRedisReachable(host: string, port: number, timeoutMs = 300): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    const done = (result: boolean) => {
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
}

describe("enqueueDexterEvent — bounded, non-latching hang prevention", () => {
  const config = loadEnv();

  it("two consecutive calls each resolve within the timeout bound and never hang, even back-to-back", async () => {
    const redisUrl = new URL(config.REDIS_URL);
    const redisReachable = await probeRedisReachable(redisUrl.hostname, Number(redisUrl.port || "6379"));

    const makeEvent = () =>
      createEvent({
        type: "dexter.plan.proposed",
        tenantId: "00000000-0000-0000-0000-000000000000",
        aggregateId: "00000000-0000-0000-0000-000000000000",
        data: {},
      });

    const start1 = Date.now();
    await enqueueDexterEvent(config, makeEvent());
    const elapsed1 = Date.now() - start1;

    const start2 = Date.now();
    await enqueueDexterEvent(config, makeEvent());
    const elapsed2 = Date.now() - start2;

    // Core guarantee, regardless of Redis's real state in whatever environment
    // this runs in: neither call ever hangs past the bounded timeout window.
    expect(elapsed1).toBeLessThan(3000);
    expect(elapsed2).toBeLessThan(3000);

    if (!redisReachable) {
      // With Redis confirmed down, a permanently-latched "is Redis up" cache
      // (the bug this test guards against) would make the *second* call return
      // near-instantly, since it would short-circuit on a cached "down" flag
      // without attempting anything. Observing it instead take close to the
      // same ~2s timeout as the first call proves each call makes its own
      // fresh, un-cached attempt rather than reusing a stale verdict.
      expect(elapsed2).toBeGreaterThan(1000);
    }
  }, 10_000);
});
