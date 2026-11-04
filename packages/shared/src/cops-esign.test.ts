import { describe, expect, it } from "vitest";
import { ENVELOPE_EVENT_STATUSES, nextEnvelopeStatus, selectEsignTemplate, type EnvelopeEventStatus, type EnvelopeStatus, type EsignTemplate } from "./cops-esign.js";

function permutations<T>(items: T[]): T[][] {
  if (items.length <= 1) return [items];
  return items.flatMap((item, i) => permutations([...items.slice(0, i), ...items.slice(i + 1)]).map((rest) => [item, ...rest]));
}
const apply = (start: EnvelopeStatus, events: EnvelopeEventStatus[]) => events.reduce<EnvelopeStatus>((status, e) => nextEnvelopeStatus(status, e) ?? status, start);

describe("COPS-08 envelope status", () => {
  it("out-of-order events converge: every ordering of the same events ends in the same status", () => {
    const sets: EnvelopeEventStatus[][] = [
      ["sent", "viewed", "signed"],
      ["sent", "viewed", "declined"],
      ["sent", "viewed", "expired"],
      ["sent", "viewed", "viewed", "signed", "sent"],
      [...ENVELOPE_EVENT_STATUSES],
    ];
    for (const events of sets) {
      const results = new Set(permutations(events).map((order) => apply("pending_send", order)));
      expect([...results]).toHaveLength(1);
    }
    expect(apply("pending_send", ["signed", "viewed", "sent"])).toBe("signed");
    expect(apply("pending_send", ["viewed", "sent"])).toBe("viewed");
  });

  it("a late event never undoes a later status, and a repeat changes nothing", () => {
    expect(nextEnvelopeStatus("signed", "viewed")).toBeNull();
    expect(nextEnvelopeStatus("signed", "signed")).toBeNull();
    expect(nextEnvelopeStatus("declined", "sent")).toBeNull();
    expect(nextEnvelopeStatus("viewed", "viewed")).toBeNull();
  });

  it("a signature beats a decline or expiry that reached us first", () => {
    expect(nextEnvelopeStatus("expired", "signed")).toBe("signed");
    expect(nextEnvelopeStatus("declined", "signed")).toBe("signed");
    expect(nextEnvelopeStatus("signed", "declined")).toBeNull();
  });

  it("a provider event revives an envelope we had marked failed or still pending", () => {
    expect(nextEnvelopeStatus("failed", "sent")).toBe("sent");
    expect(nextEnvelopeStatus("pending_send", "viewed")).toBe("viewed");
  });
});

describe("COPS-08 contract template selection", () => {
  const tpl = (match: EsignTemplate["match"], over: Partial<EsignTemplate> = {}): EsignTemplate => ({ name: "T", contract_kind: "msa", provider_template_id: "tpl", match, active: true, ...over });
  const templates = [
    { key: "msa-default", value: tpl({}) },
    { key: "msa-eu", value: tpl({ region: "EU" }) },
    { key: "msa-eu-enterprise", value: tpl({ region: "EU", segment: "enterprise" }) },
    { key: "msa-in-entity", value: tpl({ legal_entity: "Skout India Pvt Ltd" }) },
    { key: "msa-us-off", value: tpl({ region: "US" }, { active: false }) },
    { key: "dpa-default", value: tpl({}, { contract_kind: "dpa" }) },
  ];
  const pick = (context: Parameters<typeof selectEsignTemplate>[1]) => selectEsignTemplate(templates, context)?.key ?? null;

  it("picks the most specific template whose every field matches the deal", () => {
    expect(pick({ contract_kind: "msa", region: "eu", segment: "Enterprise" })).toBe("msa-eu-enterprise");
    expect(pick({ contract_kind: "msa", region: "EU", segment: "smb" })).toBe("msa-eu");
    expect(pick({ contract_kind: "msa", legal_entity: "Skout India Pvt Ltd" })).toBe("msa-in-entity");
  });

  it("falls back to the template with no conditions; an inactive template is never picked", () => {
    expect(pick({ contract_kind: "msa", region: "US" })).toBe("msa-default");
    expect(pick({ contract_kind: "msa" })).toBe("msa-default");
  });

  it("only considers templates of the contract kind, and gives null when none fits", () => {
    expect(pick({ contract_kind: "dpa", region: "EU" })).toBe("dpa-default");
    expect(pick({ contract_kind: "order_form" })).toBeNull();
  });

  it("does not depend on the order of the list", () => {
    const reversed = [...templates].reverse();
    expect(selectEsignTemplate(reversed, { contract_kind: "msa", region: "EU", segment: "enterprise" })?.key).toBe("msa-eu-enterprise");
    const tie = [{ key: "b", value: tpl({ region: "EU" }) }, { key: "a", value: tpl({ segment: "smb" }) }];
    expect(selectEsignTemplate(tie, { contract_kind: "msa", region: "EU", segment: "smb" })?.key).toBe("a");
  });
});
