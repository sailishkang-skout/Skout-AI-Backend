import { describe, expect, it } from "vitest";
import { auditEntityId } from "./audit-entity-id.js";

describe("auditEntityId", () => {
  it("passes a UUID through", () => {
    expect(auditEntityId("2F280F85-BB4D-45D4-B77C-DFC01B71EDC8")).toBe("2f280f85-bb4d-45d4-b77c-dfc01b71edc8");
  });
  it("maps a text id to a stable v5 UUID", () => {
    const a = auditEntityId("acme-prospect");
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(auditEntityId("acme-prospect")).toBe(a);
    expect(auditEntityId("other-prospect")).not.toBe(a);
  });
});
