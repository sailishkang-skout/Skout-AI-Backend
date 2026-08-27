import type { Env } from "../config/env.js";

const TELNYX_V2 = "https://api.telnyx.com/v2";

export function isTelnyxNumbersConfigured(config: Env): boolean {
  return Boolean(config.TELNYX_API_KEY);
}

function telnyxErrorMessage(json: unknown, fallback: string): string {
  if (json && typeof json === "object") {
    const errors = (json as { errors?: Array<{ detail?: string; title?: string }> }).errors;
    const first = errors?.[0];
    if (first?.detail) return first.detail;
    if (first?.title) return first.title;
    const message = (json as { message?: string }).message;
    if (message) return message;
  }
  return fallback;
}

async function telnyxFetch(config: Env, path: string, init?: RequestInit): Promise<unknown> {
  if (!config.TELNYX_API_KEY) {
    throw new Error("Telnyx is not configured (TELNYX_API_KEY)");
  }
  const res = await fetch(`${TELNYX_V2}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${config.TELNYX_API_KEY}`,
      Accept: "application/json",
      ...(init?.body ? { "content-type": "application/json" } : {}),
      ...(init?.headers ?? {}),
    },
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(telnyxErrorMessage(json, `Telnyx API returned ${res.status}`));
  }
  return json;
}

export type TelnyxAvailableNumber = {
  phoneNumber: string;
  phoneNumberType: string;
  locality: string | null;
  administrativeArea: string | null;
  countryCode: string | null;
  features: string[];
  monthlyCost: string | null;
  upfrontCost: string | null;
  currency: string | null;
};

export type TelnyxRequirement = {
  id: string;
  countryCode: string | null;
  phoneNumberType: string | null;
  action: string | null;
  description: string | null;
};

export type TelnyxNumberOrder = {
  id: string;
  status: string;
  phoneNumbers: Array<{ phoneNumber: string; id?: string; status?: string }>;
  raw: unknown;
};

export type SearchAvailableNumbersInput = {
  countryCode: string;
  phoneNumberType?: string;
  areaCode?: string;
  city?: string;
  administrativeArea?: string;
  features?: string[];
  limit?: number;
};

function regionName(
  info: Array<{ region_type?: string; region_name?: string }> | undefined,
  type: string
): string | null {
  return info?.find((r) => r.region_type === type)?.region_name ?? null;
}

export async function searchAvailablePhoneNumbers(
  config: Env,
  input: SearchAvailableNumbersInput
): Promise<TelnyxAvailableNumber[]> {
  const params = new URLSearchParams();
  params.set("filter[country_code]", input.countryCode.toUpperCase());
  if (input.phoneNumberType) params.set("filter[phone_number_type]", input.phoneNumberType);
  if (input.areaCode) params.set("filter[national_destination_code]", input.areaCode);
  if (input.city) params.set("filter[locality]", input.city);
  if (input.administrativeArea) params.set("filter[administrative_area]", input.administrativeArea);
  for (const feature of input.features ?? []) {
    params.append("filter[features][]", feature);
  }
  params.set("filter[limit]", String(input.limit ?? 20));

  const json = (await telnyxFetch(config, `/available_phone_numbers?${params.toString()}`)) as {
    data?: Array<{
      phone_number?: string;
      phone_number_type?: string;
      region_information?: Array<{ region_type?: string; region_name?: string }>;
      features?: Array<{ name?: string }>;
      cost_information?: { monthly_cost?: string; upfront_cost?: string; currency?: string };
    }>;
  };

  return (json.data ?? []).map((row) => ({
    phoneNumber: row.phone_number ?? "",
    phoneNumberType: row.phone_number_type ?? input.phoneNumberType ?? "local",
    locality: regionName(row.region_information, "location") ?? regionName(row.region_information, "locality"),
    administrativeArea: regionName(row.region_information, "state") ?? regionName(row.region_information, "province"),
    countryCode: regionName(row.region_information, "country_code") ?? input.countryCode.toUpperCase(),
    features: (row.features ?? []).map((f) => f.name ?? "").filter(Boolean),
    monthlyCost: row.cost_information?.monthly_cost ?? null,
    upfrontCost: row.cost_information?.upfront_cost ?? null,
    currency: row.cost_information?.currency ?? null,
  }));
}

export async function listNumberRequirements(
  config: Env,
  input: { countryCode: string; phoneNumberType: string; action?: string }
): Promise<TelnyxRequirement[]> {
  const params = new URLSearchParams();
  params.set("filter[country_code]", input.countryCode.toUpperCase());
  params.set("filter[phone_number_type]", input.phoneNumberType);
  params.set("filter[action]", input.action ?? "ordering");

  const json = (await telnyxFetch(config, `/requirements?${params.toString()}`)) as {
    data?: Array<{
      id?: string;
      country_code?: string;
      phone_number_type?: string;
      action?: string;
      description?: string;
    }>;
  };

  return (json.data ?? []).map((row) => ({
    id: row.id ?? "",
    countryCode: row.country_code ?? input.countryCode.toUpperCase(),
    phoneNumberType: row.phone_number_type ?? input.phoneNumberType,
    action: row.action ?? input.action ?? "ordering",
    description: row.description ?? null,
  }));
}

export async function createNumberOrder(
  config: Env,
  input: {
    phoneNumber: string;
    customerReference?: string;
    requirementGroupId?: string;
  }
): Promise<TelnyxNumberOrder> {
  const phoneNumber: Record<string, string> = { phone_number: input.phoneNumber };
  if (input.requirementGroupId) phoneNumber.requirement_group_id = input.requirementGroupId;

  const body: Record<string, unknown> = {
    phone_numbers: [phoneNumber],
    customer_reference: input.customerReference,
  };
  if (config.TELNYX_CONNECTION_ID) body.connection_id = config.TELNYX_CONNECTION_ID;
  if (config.TELNYX_MESSAGING_PROFILE_ID) body.messaging_profile_id = config.TELNYX_MESSAGING_PROFILE_ID;

  const json = (await telnyxFetch(config, "/number_orders", {
    method: "POST",
    body: JSON.stringify(body),
  })) as {
    data?: {
      id?: string;
      status?: string;
      phone_numbers?: Array<{ phone_number?: string; id?: string; status?: string }>;
    };
  };

  const data = json.data ?? {};
  return {
    id: data.id ?? "",
    status: data.status ?? "pending",
    phoneNumbers: (data.phone_numbers ?? []).map((p) => ({
      phoneNumber: p.phone_number ?? input.phoneNumber,
      id: p.id,
      status: p.status,
    })),
    raw: json,
  };
}

export async function getNumberOrder(config: Env, orderId: string): Promise<TelnyxNumberOrder> {
  const json = (await telnyxFetch(config, `/number_orders/${encodeURIComponent(orderId)}`)) as {
    data?: {
      id?: string;
      status?: string;
      phone_numbers?: Array<{ phone_number?: string; id?: string; status?: string }>;
    };
  };
  const data = json.data ?? {};
  return {
    id: data.id ?? orderId,
    status: data.status ?? "pending",
    phoneNumbers: (data.phone_numbers ?? []).map((p) => ({
      phoneNumber: p.phone_number ?? "",
      id: p.id,
      status: p.status,
    })),
    raw: json,
  };
}

export type TelnyxUploadedDocument = {
  id: string;
  filename: string | null;
};

export type TelnyxRequirementGroup = {
  id: string;
  status: string | null;
};

export async function uploadDocument(
  config: Env,
  input: { filename: string; contentBase64: string }
): Promise<TelnyxUploadedDocument> {
  const json = (await telnyxFetch(config, "/documents", {
    method: "POST",
    body: JSON.stringify({ filename: input.filename, file: input.contentBase64 }),
  })) as { data?: { id?: string; filename?: string } };
  const id = json.data?.id ?? "";
  if (!id) throw new Error("Telnyx did not return a document id");
  return { id, filename: json.data?.filename ?? input.filename };
}

export async function createRequirementGroup(
  config: Env,
  input: { countryCode: string; phoneNumberType: string; customerReference?: string }
): Promise<TelnyxRequirementGroup> {
  const json = (await telnyxFetch(config, "/requirement_groups", {
    method: "POST",
    body: JSON.stringify({
      country_code: input.countryCode.toUpperCase(),
      phone_number_type: input.phoneNumberType,
      action: "ordering",
      customer_reference: input.customerReference,
    }),
  })) as { data?: { id?: string; status?: string } };
  const id = json.data?.id ?? "";
  if (!id) throw new Error("Telnyx did not return a requirement group id");
  return { id, status: json.data?.status ?? null };
}

export async function updateRequirementGroup(
  config: Env,
  groupId: string,
  regulatoryRequirements: Array<{ requirementId: string; fieldValue: string }>
): Promise<TelnyxRequirementGroup> {
  const json = (await telnyxFetch(config, `/requirement_groups/${encodeURIComponent(groupId)}`, {
    method: "PATCH",
    body: JSON.stringify({
      regulatory_requirements: regulatoryRequirements.map((r) => ({
        requirement_id: r.requirementId,
        field_value: r.fieldValue,
      })),
    }),
  })) as { data?: { id?: string; status?: string } };
  return { id: json.data?.id ?? groupId, status: json.data?.status ?? null };
}

export type TelnyxNumbersClient = {
  searchAvailablePhoneNumbers: typeof searchAvailablePhoneNumbers;
  listNumberRequirements: typeof listNumberRequirements;
  createNumberOrder: typeof createNumberOrder;
  getNumberOrder: typeof getNumberOrder;
  uploadDocument: typeof uploadDocument;
  createRequirementGroup: typeof createRequirementGroup;
  updateRequirementGroup: typeof updateRequirementGroup;
};

export const defaultTelnyxNumbersClient: TelnyxNumbersClient = {
  searchAvailablePhoneNumbers,
  listNumberRequirements,
  createNumberOrder,
  getNumberOrder,
  uploadDocument,
  createRequirementGroup,
  updateRequirementGroup,
};
