import { describe, expect, it } from "vitest";
import { proposalPdf } from "./cops-commercial-email.service.js";

describe("proposalPdf", () => {
  it("renders a PDF with the proposal lines", async () => {
    const pdf = await proposalPdf({ title: "QA Acme Trial", version: 2, termMonths: 12, discount: " including a 10% discount", rows: [{ label: "Seats x 5", amount: "$500.00/month" }], total: "$5,400.00" });
    expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
    expect(pdf.length).toBeGreaterThan(800);
  });
});
