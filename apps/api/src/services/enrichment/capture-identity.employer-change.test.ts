import { describe, expect, it } from "vitest";
import { cleanCompanyName, isCurrentEmployerChange } from "./capture-identity.js";

describe("isCurrentEmployerChange", () => {
  const acme = [{ name: "Acme Inc.", title: "Head of Sales" }];
  it("flags a move to another company", () => {
    expect(isCurrentEmployerChange(acme, [{ name: "Globex", title: "VP Sales" }])).toBe(true);
  });
  it("flags a new title at the same company when both captures read a title", () => {
    expect(isCurrentEmployerChange(acme, [{ name: "Acme", title: "VP Sales" }])).toBe(true);
  });
  it("ignores a capture where Experience had not loaded, or the title was not read", () => {
    expect(isCurrentEmployerChange([], acme)).toBe(false);
    expect(isCurrentEmployerChange(undefined, acme)).toBe(false);
    expect(isCurrentEmployerChange(acme, [])).toBe(false);
    expect(isCurrentEmployerChange([{ name: "Acme" }], acme)).toBe(false);
    expect(isCurrentEmployerChange(acme, [{ name: "ACME Inc" }])).toBe(false);
  });
});

import { recentMoveFromHistory, roleStartDate } from "./capture-identity.js";

describe("recentMoveFromHistory", () => {
  const now = new Date("2026-11-11T00:00:00Z");
  it("does not call LinkedIn's \"+ 1 more\" or an employment type a move", () => {
    expect(isCurrentEmployerChange([{ name: "Uber", title: "Engineer" }], [{ name: "Uber + 1 more", title: "Engineer" }])).toBe(false);
    expect(isCurrentEmployerChange([{ name: "Uber · Full-time", title: "Engineer" }], [{ name: "Uber", title: "Engineer" }])).toBe(false);
    expect(cleanCompanyName("EY Technology Solutions +2 more")).toBe("EY Technology Solutions");
    expect(cleanCompanyName("Acme · Part-time")).toBe("Acme");
    expect(cleanCompanyName("Plus 500 more Ltd")).toBe("Plus 500 more Ltd");
  });
  it("ignores a capture that read more or fewer of the same current roles", () => {
    expect(isCurrentEmployerChange([{ name: "Uber", title: "Engineer" }], [{ name: "Uber", title: "Engineer" }, { name: "Side Project" }])).toBe(false);
    expect(isCurrentEmployerChange([{ name: "Uber", title: "Engineer" }, { name: "Side Project" }], [{ name: "Uber", title: "Engineer" }])).toBe(false);
  });
  it("still flags leaving the only employer for another one, or a new main employer", () => {
    expect(isCurrentEmployerChange([{ name: "Uber" }], [{ name: "Lyft" }])).toBe(true);
    expect(isCurrentEmployerChange([{ name: "Uber" }, { name: "Advisor Co" }], [{ name: "Lyft" }, { name: "Advisor Co" }])).toBe(true);
  });
  it("reads the start of LinkedIn date ranges", () => {
    expect(roleStartDate("Sep 2026 - Present · 3 mos")?.toISOString()).toBe("2026-09-01T00:00:00.000Z");
    expect(roleStartDate("2024 - Present")?.toISOString()).toBe("2024-01-01T00:00:00.000Z");
    expect(roleStartDate("Present")).toBeNull();
  });
  it("finds a move when the current role started recently at another company", () => {
    const move = recentMoveFromHistory(
      {
        currentCompanies: [{ name: "Skout AI", title: "AI Forward Deployed Engineer", dates: "Sep 2026 - Present · 3 mos" }],
        previousCompanies: [{ name: "EY Technology Solutions", title: "Senior Consultant", dates: "2023 - Aug 2026" }],
      },
      now
    );
    expect(move).toMatchObject({ from: { name: "EY Technology Solutions" }, to: [{ name: "Skout AI" }] });
  });
  it("ignores an old role, an unknown start, a same-company promotion, or no past company", () => {
    const past = [{ name: "EY", dates: "2020 - 2023" }];
    expect(recentMoveFromHistory({ currentCompanies: [{ name: "Acme", dates: "Jan 2024 - Present" }], previousCompanies: past }, now)).toBeNull();
    expect(recentMoveFromHistory({ currentCompanies: [{ name: "Acme" }], previousCompanies: past }, now)).toBeNull();
    expect(recentMoveFromHistory({ currentCompanies: [{ name: "Acme", dates: "Oct 2026 - Present" }], previousCompanies: [{ name: "Acme Inc." }] }, now)).toBeNull();
    expect(recentMoveFromHistory({ currentCompanies: [{ name: "Acme", dates: "Oct 2026 - Present" }] }, now)).toBeNull();
  });
});
