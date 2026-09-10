import { describe, expect, it } from "vitest";
import { interpolateConfig } from "./interpolate.js";

describe("interpolateConfig", () => {
  it("leaves plain config values untouched", () => {
    const config = { url: "https://example.com", method: "GET" };
    expect(interpolateConfig(config, {})).toEqual(config);
  });

  it("resolves a token embedded in a larger string, stringifying the value", () => {
    const config = { subject: "Repo status: {{n1.status}}" };
    const result = interpolateConfig(config, { n1: { status: 200 } });
    expect(result.subject).toBe("Repo status: 200");
  });

  it("preserves the raw type when the whole string is exactly one token", () => {
    const config = { seconds: "{{n1.status}}" };
    const result = interpolateConfig(config, { n1: { status: 200 } });
    expect(result.seconds).toBe(200);
    expect(typeof result.seconds).toBe("number");
  });

  it("resolves an object-typed output as JSON when embedded in a larger string", () => {
    const config = { body: "Payload: {{n1.body}}" };
    const result = interpolateConfig(config, { n1: { body: { a: 1 } } });
    expect(result.body).toBe('Payload: {"a":1}');
  });

  it("resolves an unknown reference to an empty string", () => {
    const config = { subject: "Value: {{missing.field}}" };
    const result = interpolateConfig(config, { n1: { status: 200 } });
    expect(result.subject).toBe("Value: ");
  });

  it("recurses into nested objects and arrays", () => {
    const config = { headers: { Authorization: "Bearer {{n1.token}}" }, list: ["{{n1.token}}"] };
    const result = interpolateConfig(config, { n1: { token: "abc123" } }) as any;
    expect(result.headers.Authorization).toBe("Bearer abc123");
    expect(result.list[0]).toBe("abc123");
  });

  it("leaves non-string, non-token values (numbers, booleans) untouched", () => {
    const config = { seconds: 30, enabled: true };
    expect(interpolateConfig(config, {})).toEqual(config);
  });
});
