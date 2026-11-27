import { describe, expect, it } from "vitest";
import { Writable } from "node:stream";
import pino from "pino";
import { buildPinoOptions } from "./logger.js";
import { scrubSecrets, scrubSecretsDeep } from "./redact.js";
import { scrubSentryEvent } from "./sentry.js";

const LIVE = "sk_live_0123456789ab_" + "A".repeat(43);
const TEST = "sk_test_ba9876543210_" + "b-_".repeat(14) + "z";
const COPS = "sk_cops_0123456789ab_" + "C".repeat(32);

describe("API key scrubbing (PAPI-026)", () => {
  it("replaces every public and CustomerOps key in a string", () => {
    const out = scrubSecrets(`GET /x?api_key=${LIVE}&k=${TEST} failed for ${COPS}.`);
    expect(out).toBe("GET /x?api_key=sk_live_[REDACTED]&k=sk_test_[REDACTED] failed for sk_cops_[REDACTED].");
    expect(scrubSecrets("nothing to see")).toBe("nothing to see");
  });

  it("deep-scrubs objects", () => {
    const out = scrubSecretsDeep({ a: [{ b: `Bearer ${LIVE}` }], n: 1 });
    expect(out).toEqual({ a: [{ b: "Bearer sk_live_[REDACTED]" }], n: 1 });
  });

  it("keeps keys out of every pino log line, whatever field they're in", () => {
    const lines: string[] = [];
    const sink = new Writable({
      write(chunk, _enc, cb) {
        lines.push(String(chunk));
        cb();
      },
    });
    const log = pino(buildPinoOptions({ service: "test", level: "info" }), sink);
    log.info({ url: `/api/public/v1/people?key=${LIVE}`, nested: { deep: [TEST] } }, `request with ${COPS}`);
    log.error({ err: new Error(`provider rejected ${LIVE}`), headers: { authorization: `Bearer ${LIVE}` } }, "boom");
    const all = lines.join("");
    expect(all).not.toContain(LIVE);
    expect(all).not.toContain(TEST);
    expect(all).not.toContain(COPS);
    expect(all).toContain("sk_live_[REDACTED]");
    expect(lines).toHaveLength(2);
    for (const line of lines) expect(() => JSON.parse(line)).not.toThrow();
  });

  it("strips credentials from Sentry events", () => {
    const event = scrubSentryEvent({
      request: { url: `https://www.skoutai.io/api/public/v1/x?api_key=${LIVE}`, headers: { Authorization: `Bearer ${LIVE}`, cookie: "s=1", "user-agent": "curl" } },
      exception: { values: [{ value: `bad key ${TEST}` }] },
      extra: { token: COPS },
    });
    const json = JSON.stringify(event);
    expect(json).not.toContain(LIVE);
    expect(json).not.toContain(TEST);
    expect(json).not.toContain(COPS);
    expect(event.request!.headers).toEqual({ "user-agent": "curl" });
  });
});
