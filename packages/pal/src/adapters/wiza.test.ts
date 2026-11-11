// cSpell:ignore wiza linkedin
import { afterEach, describe, expect, it, vi } from "vitest";
import { WizaEmailFinder, WizaPhone } from "./wiza.js";

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
const fast = { pollIntervalMs: 1, maxWaitMs: 200 };

describe("Wiza reveal", () => {
  afterEach(() => vi.restoreAllMocks());

  it("creates a reveal from the LinkedIn URL, polls until complete, and returns the email", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(json({ data: { id: 42, status: "queued", is_complete: false } }))
      .mockResolvedValueOnce(json({ data: { id: 42, status: "resolving", is_complete: false } }))
      .mockResolvedValueOnce(json({ data: { id: 42, status: "finished", is_complete: true, email: "ada@acme.com", email_status: "valid" } }));

    const found = await new WizaEmailFinder("k", "https://wiza.test", undefined, fast).findEmail(
      "Ada L",
      "linkedin-capture.local",
      { linkedinUrl: "https://linkedin.com/in/ada" }
    );

    expect(found).toEqual({ email: "ada@acme.com", confidence: 0.95 });
    const [createUrl, createInit] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(createUrl).toBe("https://wiza.test/api/individual_reveals");
    expect(createInit.headers).toMatchObject({ Authorization: "Bearer k" });
    expect(JSON.parse(String(createInit.body))).toMatchObject({
      individual_reveal: { profile_url: "https://linkedin.com/in/ada" },
      enrichment_level: "partial",
    });
    expect(String(fetchMock.mock.calls[1]![0])).toBe("https://wiza.test/api/individual_reveals/42");
  });

  it("falls back to name + domain when there is no LinkedIn URL, and skips when it cannot identify anyone", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => json({ data: { id: 1, is_complete: true, status: "finished", email: "a@acme.com", email_status: "risky" } }));
    const finder = new WizaEmailFinder("k", "https://wiza.test", undefined, fast);

    expect(await finder.findEmail("Ada L", "acme.com")).toEqual({ email: "a@acme.com", confidence: 0.6 });
    expect(JSON.parse(String((fetchMock.mock.calls[0]![1] as RequestInit).body)).individual_reveal).toEqual({
      full_name: "Ada L",
      domain: "acme.com",
    });

    fetchMock.mockClear();
    expect(await finder.findEmail("Ada L", "linkedin-capture.local")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled(); // nothing to identify → no billable call
  });

  it("returns null (a miss) for unfound emails and failed reveals", async () => {
    const spy = vi.spyOn(globalThis, "fetch");
    const finder = new WizaEmailFinder("k", "https://wiza.test", undefined, fast);
    spy.mockResolvedValueOnce(json({ data: { id: 1, is_complete: true, status: "finished", email_status: "unfound" } }));
    expect(await finder.findEmail("A B", "acme.com")).toBeNull();
    spy.mockResolvedValueOnce(json({ data: { id: 2, is_complete: true, status: "failed" } }));
    expect(await finder.findEmail("A B", "acme.com")).toBeNull();
  });

  it("throws when a reveal does not complete in time", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => json({ data: { id: 9, status: "queued", is_complete: false } }));
    await expect(
      new WizaEmailFinder("k", "https://wiza.test", undefined, { pollIntervalMs: 1, maxWaitMs: 20 }).findEmail("A B", "acme.com")
    ).rejects.toThrow(/timed out/);
  });

  it("returns phones from a phone-level reveal", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(json({ data: { id: 3, is_complete: true, status: "finished", mobile_phone: "+1 555 0100", phone_number: "+1 555 0199" } }));
    const phone = await new WizaPhone("k", "https://wiza.test", undefined, fast).fetchPhone("Ada L", "acme.com", "https://linkedin.com/in/ada");
    expect(phone).toEqual({ mobile: "+1 555 0100", direct: "+1 555 0199" });
    expect(JSON.parse(String((fetchMock.mock.calls[0]![1] as RequestInit).body)).enrichment_level).toBe("phone");
  });
});
