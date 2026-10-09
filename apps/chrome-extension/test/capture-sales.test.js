import { describe, expect, it } from "vitest";
import vm from "node:vm";
import { readSource } from "./helpers/capture-dom.js";


/** A rendered Sales Navigator people search, ported from the prototype's pagination fixture. */
function salesSearch({ total, publicLinks = true, resolveLinks, pageSize = 25 }) {
  const PAGE_SIZE = pageSize;
  const pages = Math.ceil(total / PAGE_SIZE);
  let page = 1;
  let reviewed;
  const clicked = [];
  const makeCard = (index) => {
    const leadLink = { href: `https://www.linkedin.com/sales/lead/id${index},NAME_SEARCH,x` };
    const publicLink = { href: `https://www.linkedin.com/in/person-${index}/` };
    return {
      parentElement: null,
      closest: () => null,
      querySelector(selector) {
        if (selector.startsWith("a[data-lead-search-result")) return leadLink;
        if (selector === '[data-anonymize="person-name"]') return { textContent: `Person ${index}` };
        if (selector === '[data-anonymize="title"]') return { textContent: "HR associate" };
        if (selector === 'a[data-anonymize="company-name"]') {
          return { textContent: "Blinkit", href: "https://www.linkedin.com/sales/company/80918929" };
        }
        return null;
      },
      querySelectorAll(selector) {
        return selector === 'a[href*="/in/"]' && publicLinks ? [publicLink] : [];
      },
    };
  };
  const cards = Array.from({ length: pages }, (_, pageIndex) =>
    Array.from({ length: Math.min(PAGE_SIZE, total - pageIndex * PAGE_SIZE) }, (_, index) => makeCard(pageIndex * PAGE_SIZE + index))
  );
  const document = {
    body: {
      get innerText() {
        return `${total} results Page ${page} of ${pages}`;
      },
    },
    querySelectorAll(selector) {
      if (selector === 'main [data-x-search-result="LEAD"]') return cards[page - 1];
      if (selector === "button") {
        return Array.from({ length: pages }, (_, index) => ({
          getAttribute: (name) => (name === "aria-label" ? `Page ${index + 1}` : null),
          click() {
            clicked.push(`Page ${index + 1}`);
            page = index + 1;
          },
          disabled: false,
        }));
      }
      return [];
    },
    querySelector(selector) {
      if (selector === 'main [data-x-search-result="LEAD"] a[href*="/sales/lead/"]') {
        return cards[page - 1][0].querySelector('a[data-lead-search-result^="profile-link"][href*="/sales/lead/"]');
      }
      if (selector === 'main [data-x-search-result="LEAD"]') return cards[page - 1][0];
      return null;
    },
  };
  const messages = [];
  const context = vm.createContext({
    document,
    location: { href: "https://www.linkedin.com/sales/search/people?query=(filters:List((type:FUNCTION,values:List((id:12,text:Human%20Resources,selectionType:INCLUDED)))))", pathname: "/sales/search/people" },
    URL,
    setTimeout: (callback) => {
      callback();
      return 0;
    },
    SkoutCaptureUi: {
      progress: () => ({ set() {}, stopped: false, onStop() {}, done() {} }),
      review: async (kind, data, notes) => {
        reviewed = { kind, data, notes };
      },
    },
    chrome: {
      runtime: {
        sendMessage: async (message) => {
          messages.push(message);
          if (message.type !== "RESOLVE_SALES_LEAD_LINKS" || !resolveLinks) throw new Error("no lookup expected");
          return { ok: true, data: { links: resolveLinks(message.leads.map((lead) => lead.url)), cancelled: false } };
        },
      },
    },
  });
  context.globalThis = context;
  vm.runInContext(readSource("capture/sales-navigator-capture.js"), context);
  return {
    run: async () => {
      await context.SkoutSalesNavigatorCapture.start();
      return reviewed;
    },
    clicked,
    messages,
    currentPage: () => page,
  };
}

describe("Sales Navigator capture", () => {
  it("reads all eight rendered pages of a 183-lead search without duplicate leads", async () => {
    const search = salesSearch({ total: 183 });
    const reviewed = await search.run();
    expect(reviewed.kind).toBe("sales");
    expect(reviewed.data.peopleProfiles).toHaveLength(183);
    expect(new Set(reviewed.data.peopleProfiles.map((item) => item.relationshipContext.salesNavigatorLeadUrl)).size).toBe(183);
    expect(reviewed.data.pagesRead).toBe(8);
    expect(reviewed.data.resultCount).toBe(183);
    expect(search.currentPage()).toBe(8);
    expect(reviewed.data.filters).toEqual(["function: Human Resources (included)"]);
  });

  it("stops at 10 pages and 250 leads", async () => {
    const search = salesSearch({ total: 300 });
    const reviewed = await search.run();
    expect(reviewed.data.pagesRead).toBe(10);
    expect(reviewed.data.peopleProfiles).toHaveLength(250);
    expect(search.currentPage()).toBe(10);
  });

  it("stops at 250 leads even when fewer than 10 pages were needed", async () => {
    const search = salesSearch({ total: 400, pageSize: 40 });
    const reviewed = await search.run();
    expect(reviewed.data.peopleProfiles).toHaveLength(250);
    expect(reviewed.data.pagesRead).toBe(7);
    expect(search.currentPage()).toBe(7);
  });

  it("only moves between result pages: no filters set, no search submitted, no messages sent", async () => {
    const search = salesSearch({ total: 183 });
    await search.run();
    expect(search.clicked).toEqual(["Page 2", "Page 3", "Page 4", "Page 5", "Page 6", "Page 7", "Page 8"]);
    // Public links were already visible on the cards, so nothing was asked of the background.
    expect(search.messages).toEqual([]);
  });

  it("keeps Sales-only leads as sales-lead records and never invents a public URL", async () => {
    const search = salesSearch({
      total: 30,
      publicLinks: false,
      // LinkedIn showed a public link on every third lead page; one answer is not a profile URL.
      resolveLinks: (urls) =>
        Object.fromEntries(
          urls.flatMap((url) => {
            const index = Number(url.match(/id(\d+),/)[1]);
            if (index === 1) return [[url, "https://www.linkedin.com/sales/lead/id1"]];
            return index % 3 === 0 ? [[url, `https://www.linkedin.com/in/real-${index}/`]] : [];
          })
        ),
    });
    const { data } = await search.run();
    const resolved = data.peopleProfiles.filter((profile) => profile.sourceUrl.includes("/in/"));
    const salesOnly = data.peopleProfiles.filter((profile) => !profile.sourceUrl.includes("/in/"));
    expect(resolved).toHaveLength(10);
    expect(resolved.every((profile) => profile.sourceUrl === `https://www.linkedin.com/in/${profile.publicId}/` && profile.publicId.startsWith("real-"))).toBe(true);
    expect(salesOnly).toHaveLength(20);
    for (const profile of salesOnly) {
      expect(profile.publicId).toMatch(/^sales-lead:id\d+$/);
      expect(profile.sourceUrl).toBe(profile.relationshipContext.salesNavigatorLeadUrl);
    }
    // Lead pages are looked up in sequential batches of at most ten.
    expect(search.messages.map((message) => message.leads.length)).toEqual([10, 10, 10]);
  });
});
