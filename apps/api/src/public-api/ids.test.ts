import { describe, expect, it } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import { createPublicIdCodec, findInternalLeaks, publicIdSecret } from "./ids.js";
import { publicRequestId } from "./errors.js";

const codec = createPublicIdCodec(randomBytes(32).toString("base64"));

describe("public ids (PAPI-043, CONV-8)", () => {
  it("round-trips UUIDs, 64-hex prospect ids and other ids, with a type prefix and no trace of the internal id", () => {
    const uuid = randomUUID();
    const hex = randomBytes(32).toString("hex");
    const per = codec.encode("person", uuid);
    expect(per).toMatch(/^per_[A-Za-z0-9_-]+$/);
    expect(per).not.toContain(uuid.replace(/-/g, "").slice(0, 8));
    expect(findInternalLeaks({ id: per })).toEqual([]);
    expect(codec.decode("person", per)).toBe(uuid);
    expect(codec.decode("company", codec.encode("company", hex))).toBe(hex);
    expect(codec.decode("job", codec.encode("job", "linkedin:12345"))).toBe("linkedin:12345");
    expect(codec.encode("company", hex)).toMatch(/^com_/);
    expect(codec.encode("webhook", uuid)).toMatch(/^whk_/);
    expect(per.length).toBeLessThan(70);
  });

  it("is stable for the same record and different per type", () => {
    const uuid = randomUUID();
    expect(codec.encode("person", uuid)).toBe(codec.encode("person", uuid));
    expect(codec.encode("person", uuid).slice(4)).not.toBe(codec.encode("company", uuid).slice(4));
    expect(codec.encode("person", uuid)).not.toBe(codec.encode("person", randomUUID()));
  });

  it("refuses tampered ids, ids of another type, other secrets and junk", () => {
    const per = codec.encode("person", randomUUID());
    const flipped = per.slice(0, -2) + (per.endsWith("AA") ? "BB" : "AA");
    expect(codec.decode("person", flipped)).toBeNull();
    expect(codec.decode("company", per)).toBeNull();
    expect(codec.decode("company", `com_${per.slice(4)}`)).toBeNull();
    expect(createPublicIdCodec(randomBytes(32).toString("base64")).decode("person", per)).toBeNull();
    for (const junk of ["", "per_", "per_abc", randomUUID(), `per_${"A".repeat(700)}`]) expect(codec.decode("person", junk)).toBeNull();
  });

  it("derives a stable secret from the pepper unless PUBLIC_API_ID_SECRET is set", () => {
    const pepper = randomBytes(32).toString("base64");
    expect(publicIdSecret({ API_KEY_PEPPER: pepper })).toBe(publicIdSecret({ API_KEY_PEPPER: pepper }));
    expect(publicIdSecret({ API_KEY_PEPPER: pepper })).not.toBe(pepper);
    expect(publicIdSecret({ PUBLIC_API_ID_SECRET: "x".repeat(40), API_KEY_PEPPER: pepper })).toBe("x".repeat(40));
    expect(publicIdSecret({})).toBeNull();
  });

  it("shows customers request ids without a UUID in them", () => {
    const id = randomUUID();
    expect(publicRequestId(id)).toBe(`req_${id.replace(/-/g, "")}`);
    expect(findInternalLeaks({ request_id: publicRequestId(id) })).toEqual([]);
  });
});

describe("leak guard", () => {
  it("finds internal UUIDs anywhere and provider names in source fields", () => {
    const uuid = randomUUID();
    expect(findInternalLeaks({ data: [{ id: uuid }] })).toEqual(["$.data[0].id: internal id"]);
    expect(findInternalLeaks({ note: `see ${uuid}` })).toHaveLength(1);
    expect(findInternalLeaks({ [uuid]: 1 })).toHaveLength(1);
    expect(findInternalLeaks({ source: "Wiza" })).toEqual(["$.source: provider name"]);
    expect(findInternalLeaks({ result: { providers: ["contactout", "datagma"] } })).toHaveLength(2);
    expect(findInternalLeaks({ wiza: { ok: true } })).toEqual(["$.wiza: provider name as a key"]);
  });

  it("leaves real people's and companies' data alone", () => {
    expect(
      findInternalLeaks({
        data: { id: codec.encode("company", randomUUID()), name: "Hunter Douglas", industry: "Apollo Tyres supplier", data_origin: "external", email: "ada@lusha-example.com" },
      })
    ).toEqual([]);
  });
});
