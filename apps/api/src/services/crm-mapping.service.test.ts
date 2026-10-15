import { describe, expect, it, vi } from "vitest";
import {
  applyInboundMapping,
  applyOutboundMapping,
  DEFAULT_HUBSPOT_CONTACT_MAPPING,
  DEFAULT_HUBSPOT_DEAL_MAPPING,
  getDefaultCrmMappings,
  getResolvedCrmMapping,
  saveCrmMappings,
  testMappingTransformation,
  transformValue,
  validateMapping,
} from "./crm-mapping.service.js";

describe("transformValue", () => {
  it("handles null and undefined", () => {
    expect(transformValue(null, "trim")).toBeNull();
    expect(transformValue(undefined, "lowercase")).toBeNull();
  });

  it("applies trim, lowercase, uppercase transforms", () => {
    expect(transformValue("  hello world  ", "trim")).toBe("hello world");
    expect(transformValue("  User@Example.COM  ", "lowercase")).toBe("user@example.com");
    expect(transformValue("ceo", "uppercase")).toBe("CEO");
  });

  it("parses numbers from numeric strings", () => {
    expect(transformValue("$15,000.50", "number")).toBe(15000.5);
    expect(transformValue("250", "number")).toBe(250);
  });
});

describe("applyInboundMapping", () => {
  it("transforms HubSpot contact properties into Skout native patch", () => {
    const external = {
      email: "  Test.User@Acme.CORP  ",
      firstname: "Test ",
      lastname: " User",
      phone: "+1-555-0100",
      jobtitle: " VP Engineering ",
    };

    const { patch, appliedFields } = applyInboundMapping(DEFAULT_HUBSPOT_CONTACT_MAPPING, external);

    expect(patch).toEqual({
      email: "test.user@acme.corp",
      firstName: "Test",
      lastName: "User",
      phone: "+1-555-0100",
      title: "VP Engineering",
    });
    expect(appliedFields).toContain("email");
    expect(appliedFields).toContain("firstName");
  });

  it("ignores null/empty values when nullBehavior is ignore", () => {
    const external = {
      email: "valid@example.com",
      firstname: "   ",
      lastname: null,
    };

    const { patch, skippedFields } = applyInboundMapping(DEFAULT_HUBSPOT_CONTACT_MAPPING, external);
    expect(patch).toEqual({ email: "valid@example.com" });
    expect(skippedFields).toContain("firstName");
    expect(skippedFields).toContain("lastName");
  });

  it("sets null when nullBehavior is overwrite", () => {
    const mapping = {
      ...DEFAULT_HUBSPOT_CONTACT_MAPPING,
      fields: [
        {
          id: "f1",
          internalField: "phone",
          externalField: "phone",
          direction: "inbound" as const,
          nullBehavior: "overwrite" as const,
        },
      ],
    };

    const { patch } = applyInboundMapping(mapping, { phone: "" });
    expect(patch).toEqual({ phone: null });
  });
});

describe("applyOutboundMapping", () => {
  it("transforms internal patch into HubSpot properties", () => {
    const internal = {
      firstName: "Alice",
      lastName: "Smith",
      email: "alice@example.com",
      otherFieldNotMapped: 12345,
    };

    const { properties, appliedFields } = applyOutboundMapping(DEFAULT_HUBSPOT_CONTACT_MAPPING, internal);

    expect(properties).toEqual({
      firstname: "Alice",
      lastname: "Smith",
      email: "alice@example.com",
    });
    expect(appliedFields).toEqual(["email", "firstname", "lastname"]);
  });

  it("maps deal patch correctly", () => {
    const internal = {
      name: "Acme Expansion",
      amount: 50000,
    };

    const { properties } = applyOutboundMapping(DEFAULT_HUBSPOT_DEAL_MAPPING, internal);
    expect(properties).toEqual({
      dealname: "Acme Expansion",
      amount: "50000",
    });
  });
});

describe("validateMapping", () => {
  it("validates a healthy default mapping", () => {
    const res = validateMapping(DEFAULT_HUBSPOT_CONTACT_MAPPING);
    expect(res.valid).toBe(true);
    expect(res.errors).toHaveLength(0);
  });

  it("detects invalid version, entityType, and missing fields", () => {
    const badMapping: any = {
      version: 0,
      entityType: "invoice",
      fields: [{ internalField: "email" }], // missing externalField
    };

    const res = validateMapping(badMapping);
    expect(res.valid).toBe(false);
    expect(res.errors.some((e) => e.includes("version"))).toBe(true);
    expect(res.errors.some((e) => e.includes("entityType"))).toBe(true);
    expect(res.errors.some((e) => e.includes("missing externalField"))).toBe(true);
  });

  it("detects schema drift when external properties do not match provider schema", () => {
    const availableProviderProperties = ["email", "firstname", "phone"]; // missing lastname and jobtitle
    const res = validateMapping(DEFAULT_HUBSPOT_CONTACT_MAPPING, availableProviderProperties);

    expect(res.missingExternalProperties).toContain("lastname");
    expect(res.missingExternalProperties).toContain("jobtitle");
  });
});

describe("testMappingTransformation", () => {
  it("tests inbound transformation", () => {
    const sample = { email: "SAMPLE@EXAMPLE.COM", firstname: " John " };
    const res = testMappingTransformation(DEFAULT_HUBSPOT_CONTACT_MAPPING, sample, "inbound");

    expect(res.direction).toBe("inbound");
    expect(res.output).toEqual({
      email: "sample@example.com",
      firstName: "John",
    });
  });

  it("tests outbound transformation", () => {
    const sample = { firstName: "Jane", amount: 1000 };
    const res = testMappingTransformation(DEFAULT_HUBSPOT_CONTACT_MAPPING, sample, "outbound");

    expect(res.direction).toBe("outbound");
    expect(res.output).toEqual({
      firstname: "Jane",
    });
  });
});

describe("getDefaultCrmMappings", () => {
  it("returns default hubspot mappings with version 1", () => {
    const defaults = getDefaultCrmMappings("hubspot");
    expect(defaults.provider).toBe("hubspot");
    expect(defaults.version).toBe(1);
    expect(defaults.mappings.contact.entityType).toBe("contact");
    expect(defaults.mappings.deal.entityType).toBe("deal");
  });
});

describe("getResolvedCrmMapping & saveCrmMappings", () => {
  it("falls back to default mappings when connection has no custom mapping", async () => {
    const dbMock = {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([{ settings: {} }]),
          }),
        }),
      }),
    };

    const mapping = await getResolvedCrmMapping(dbMock as any, "ws-1", "hubspot", "contact");
    expect(mapping.version).toBe(1);
    expect(mapping.entityType).toBe("contact");
    expect(mapping.fields).toEqual(DEFAULT_HUBSPOT_CONTACT_MAPPING.fields);
  });

  it("returns custom mapping when configured on connection", async () => {
    const customContact = {
      version: 2,
      entityType: "contact" as const,
      externalObjectType: "contacts",
      fields: [
        {
          id: "custom_field",
          internalField: "customField",
          externalField: "hs_custom",
          direction: "bidirectional" as const,
        },
      ],
    };

    const dbMock = {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([{ settings: { mappings: { contact: customContact } } }]),
          }),
        }),
      }),
    };

    const mapping = await getResolvedCrmMapping(dbMock as any, "ws-1", "hubspot", "contact");
    expect(mapping.version).toBe(2);
    expect(mapping.fields[0]?.internalField).toBe("customField");
  });

  it("saves updated mappings into connection settings", async () => {
    let updatedSet: any;
    const dbMock = {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([{ id: "conn-1", settings: { otherSetting: 123 } }]),
          }),
        }),
      }),
      update: vi.fn().mockReturnValue({
        set: vi.fn().mockImplementation((val) => {
          updatedSet = val;
          return {
            where: vi.fn().mockResolvedValue([]),
          };
        }),
      }),
    };

    await saveCrmMappings(dbMock as any, "ws-1", "hubspot", {
      contact: DEFAULT_HUBSPOT_CONTACT_MAPPING,
    });

    expect(updatedSet).toMatchObject({
      settings: {
        otherSetting: 123,
        mappings: {
          contact: DEFAULT_HUBSPOT_CONTACT_MAPPING,
        },
      },
    });
  });
});


