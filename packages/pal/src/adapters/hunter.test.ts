import { afterEach, describe, expect, it, vi } from "vitest";
import { HunterEmailFinder } from "./hunter.js";

describe("HunterEmailFinder", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("uses domain + split name for real company domains", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ data: { email: "jane@acme.com", score: 90 } }), { status: 200 })
    );

    const finder = new HunterEmailFinder("test-key", "https://api.hunter.io/v2");
    const found = await finder.findEmail("Jane Doe", "acme.com");

    expect(found?.email).toBe("jane@acme.com");
    const url = String(fetchMock.mock.calls[0]?.[0]);
    expect(url).toContain("domain=acme.com");
    expect(url).toContain("first_name=jane");
    expect(url).toContain("last_name=doe");
    expect(url).not.toContain("linkedin_handle");
  });

  it("uses linkedin_handle for synthetic capture domains", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ data: { email: "founder@openchat.com", score: 85 } }), {
        status: 200,
      })
    );

    const finder = new HunterEmailFinder("test-key", "https://api.hunter.io/v2");
    const found = await finder.findEmail("Alex Founder", "openchat.linkedin", {
      companyName: "OpenChat",
      linkedinUrl: "https://www.linkedin.com/in/alex-founder/",
    });

    expect(found?.email).toBe("founder@openchat.com");
    const url = String(fetchMock.mock.calls[0]?.[0]);
    expect(url).toContain("linkedin_handle=alex-founder");
    expect(url).toContain("full_name=Alex+Founder");
    expect(url).not.toContain("domain=openchat.linkedin");
  });

  it("falls back to company name when no LinkedIn URL is available", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ data: { email: "hi@openchat.com", score: 80 } }), { status: 200 })
    );

    const finder = new HunterEmailFinder("test-key", "https://api.hunter.io/v2");
    await finder.findEmail("Alex Founder", "openchat.linkedin", { companyName: "OpenChat" });

    const url = String((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]);
    expect(url).toContain("company=OpenChat");
    expect(url).not.toContain("domain=");
  });

  it("skips the API call when capture domain has no LinkedIn URL or company", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");

    const finder = new HunterEmailFinder("test-key", "https://api.hunter.io/v2");
    const found = await finder.findEmail("Alex Founder", "openchat.linkedin");

    expect(found).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
