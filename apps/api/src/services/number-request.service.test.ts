import { afterEach, describe, expect, it, vi } from "vitest";
import {
  canTransition,
  NUMBER_REQUEST_TRANSITIONS,
  NUMBER_REQUEST_STATUSES,
  pickWorkspaceCallerId,
} from "./number-request.service.js";
import {
  createNumberOrder,
  createRequirementGroup,
  searchAvailablePhoneNumbers,
  uploadDocument,
} from "./telnyx-numbers.client.js";

const CONFIG = { TELNYX_API_KEY: "KEY_test", TELNYX_CONNECTION_ID: "conn_123" } as never;

afterEach(() => {
  vi.restoreAllMocks();
});

describe("number request state machine", () => {
  it("covers all 11 statuses", () => {
    expect(NUMBER_REQUEST_STATUSES).toHaveLength(11);
  });

  it("allows the marketplace happy path", () => {
    expect(canTransition("requested", "selected")).toBe(true);
    expect(canTransition("selected", "requirements_pending")).toBe(true);
    expect(canTransition("requirements_pending", "compliance_submitted")).toBe(true);
    expect(canTransition("compliance_submitted", "compliance_review")).toBe(true);
    expect(canTransition("compliance_review", "ordering")).toBe(true);
    expect(canTransition("ordering", "provisioning")).toBe(true);
    expect(canTransition("provisioning", "active")).toBe(true);
  });

  it("allows skip-to-order when no regulatory docs are needed", () => {
    expect(canTransition("selected", "ordering")).toBe(true);
  });

  it("rejects illegal jumps and terminal re-entry", () => {
    expect(canTransition("requested", "active")).toBe(false);
    expect(canTransition("active", "cancelled")).toBe(false);
    expect(canTransition("failed", "ordering")).toBe(false);
    expect(canTransition("cancelled", "requested")).toBe(false);
  });

  it("every status is a key in the transition map", () => {
    for (const status of NUMBER_REQUEST_STATUSES) {
      expect(NUMBER_REQUEST_TRANSITIONS[status]).toBeDefined();
    }
  });
});

describe("searchAvailablePhoneNumbers", () => {
  it("requires country_code on the Telnyx search URL", async () => {
    const fetchSpy = vi.spyOn(global, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          data: [
            {
              phone_number: "+14155551234",
              phone_number_type: "local",
              features: [{ name: "voice" }, { name: "sms" }],
              cost_information: { monthly_cost: "1.00", currency: "USD" },
              region_information: [{ region_type: "state", region_name: "CA" }],
            },
          ],
        }),
        { status: 200 }
      )
    );

    const rows = await searchAvailablePhoneNumbers(CONFIG, {
      countryCode: "us",
      phoneNumberType: "local",
      areaCode: "415",
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]?.phoneNumber).toBe("+14155551234");
    const url = String(fetchSpy.mock.calls[0]![0]);
    expect(url).toContain("https://api.telnyx.com/v2/available_phone_numbers?");
    expect(url).toContain("filter%5Bcountry_code%5D=US");
    expect(url).toContain("filter%5Bnational_destination_code%5D=415");
  });

  it("throws Telnyx error detail on search failure", async () => {
    vi.spyOn(global, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ errors: [{ detail: "Account not verified" }] }), { status: 403 })
    );
    await expect(searchAvailablePhoneNumbers(CONFIG, { countryCode: "US" })).rejects.toThrow(
      "Account not verified"
    );
  });
});

describe("pickWorkspaceCallerId", () => {
  it("prefers the workspace's active DID over the env fallback", () => {
    expect(pickWorkspaceCallerId(["+14155550001"], "+15005550006")).toBe("+14155550001");
  });

  it("skips empty assignments and uses the platform number", () => {
    expect(pickWorkspaceCallerId([null, "  ", undefined], "+15005550006")).toBe("+15005550006");
  });

  it("returns null when nothing is assigned", () => {
    expect(pickWorkspaceCallerId([], undefined)).toBeNull();
  });
});

describe("Telnyx documents and requirement groups", () => {
  it("uploads a document as JSON filename + base64 file", async () => {
    const fetchSpy = vi.spyOn(global, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ data: { id: "doc_1", filename: "kyc.pdf" } }), { status: 200 })
    );

    const result = await uploadDocument(CONFIG, { filename: "kyc.pdf", contentBase64: "AAA=" });
    expect(result).toEqual({ id: "doc_1", filename: "kyc.pdf" });
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toBe("https://api.telnyx.com/v2/documents");
    expect(JSON.parse(init?.body as string)).toEqual({ filename: "kyc.pdf", file: "AAA=" });
  });

  it("creates an ordering requirement group", async () => {
    vi.spyOn(global, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ data: { id: "rg_1", status: "unapproved" } }), { status: 200 })
    );
    const group = await createRequirementGroup(CONFIG, { countryCode: "de", phoneNumberType: "local" });
    expect(group.id).toBe("rg_1");
  });

  it("puts requirement_group_id on each phone_numbers entry when ordering", async () => {
    const fetchSpy = vi.spyOn(global, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ data: { id: "ord_1", status: "pending", phone_numbers: [] } }), {
        status: 200,
      })
    );
    await createNumberOrder(CONFIG, {
      phoneNumber: "+14155551234",
      customerReference: "skout:ws:req",
      requirementGroupId: "rg_1",
    });
    const body = JSON.parse(fetchSpy.mock.calls[0]![1]?.body as string) as {
      phone_numbers: Array<{ phone_number: string; requirement_group_id?: string }>;
    };
    expect(body.phone_numbers[0]).toEqual({
      phone_number: "+14155551234",
      requirement_group_id: "rg_1",
    });
  });
});
