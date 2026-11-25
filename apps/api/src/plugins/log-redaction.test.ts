import { describe, expect, it } from "vitest";
import { Writable } from "node:stream";
import Fastify from "fastify";
import { buildPinoOptions } from "@skout/observability";
import { generatePublicApiKey } from "../services/public-api-keys.service.js";

/**
 * PAPI-026: a request carrying an API key is logged (request line, error with the key in its message,
 * the headers object) with the same logger options the API uses (buildApp → buildPinoOptions), and the
 * key appears nowhere in the output.
 */
describe("log redaction of API keys (PAPI-026)", () => {
  it("keeps the key out of request logs and error logs", async () => {
    const lines: string[] = [];
    const stream = new Writable({
      write(chunk, _enc, cb) {
        lines.push(String(chunk));
        cb();
      },
    });
    const app = Fastify({ logger: { ...buildPinoOptions({ service: "skout-api", level: "info" }), stream } });
    app.get("/api/public/v1/echo", async (request) => {
      request.log.info({ headers: request.headers }, "incoming headers");
      throw new Error(`upstream refused key ${request.headers.authorization}`);
    });
    await app.ready();

    const { key } = generatePublicApiKey("live", "pepper-for-test-only-0123456789abcdefghijk");
    const res = await app.inject({
      method: "GET",
      url: `/api/public/v1/echo?api_key=${key}`,
      headers: { authorization: `Bearer ${key}`, cookie: `token=${key}` },
    });
    expect(res.statusCode).toBe(500);
    await app.close();

    const output = lines.join("");
    expect(lines.length).toBeGreaterThanOrEqual(3);
    expect(output).not.toContain(key);
    expect(output).not.toContain(key.split("_").pop()!); // not even the secret part
    expect(output).toContain("sk_live_[REDACTED]");
  });
});
