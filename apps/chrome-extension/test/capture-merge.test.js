import { describe, expect, it } from "vitest";
import { loadCapturePage } from "./helpers/capture-dom.js";
import { setRoleField } from "../capture-panel.js";

const EXTRACT_FILES = ["capture/extract-common.js", "capture/page-extract.js"];

describe("person capture merge", () => {
  it("drops header-only education and company once real rows load", () => {
    const window = loadCapturePage({
      url: "https://www.linkedin.com/in/jane-doe/",
      html: "<main></main>",
      files: [...EXTRACT_FILES, "capture/restriction-detect.js", "capture/capture-ui.js", "capture/person-capture.js"],
    });
    const out = window.SkoutPersonCapture.merge(
      { educations: [{ school: "IIT Delhi", source: "topcard" }], currentCompanies: [{ company: "Uber", source: "topcard" }] },
      { educations: [{ school: "IIT Delhi", degree: "BTech" }], currentCompanies: [{ name: "Uber", title: "Software Engineer" }] },
    );
    expect(JSON.parse(JSON.stringify(out.educations))).toEqual([{ school: "IIT Delhi", degree: "BTech" }]);
    expect(JSON.parse(JSON.stringify(out.currentCompanies))).toEqual([{ name: "Uber", title: "Software Engineer" }]);
  });
});

describe("review dialog company fields", () => {
  it("edits the most recent role", () => {
    const data = { currentCompanies: [{ name: "Uber", title: "Engineer" }, { name: "Side gig" }] };
    setRoleField(data, { list: "currentCompanies", key: "name" }, "Uber Technologies");
    setRoleField(data, { list: "previousCompanies", key: "name" }, "Lyft");
    expect(data.currentCompanies[0]).toEqual({ name: "Uber Technologies", title: "Engineer" });
    expect(data.previousCompanies).toEqual([{ name: "Lyft" }]);
  });
});

describe("captured company people names", () => {
  it("shows the captured name, or a readable name from the profile link", async () => {
    const { leadName } = await import("../capture-panel.js");
    expect(leadName({ fullName: "Priya Sharma" })).toBe("Priya Sharma");
    expect(leadName({ publicId: "priya-sharma-1a2b3c4d" })).toBe("Priya Sharma");
    expect(leadName({})).toBe("Unknown person");
  });
});
