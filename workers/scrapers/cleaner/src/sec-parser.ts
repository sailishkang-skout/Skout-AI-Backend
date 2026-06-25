/** Parse SEC EDGAR search / companyfacts payloads into firmographics. */

export function parseSecEdgarPayload(payload: Record<string, unknown>): {
  domain?: string;
  companyName?: string;
  annualRevenue?: number;
  isPublic?: boolean;
  funding?: { lastRound?: string; lastRoundDate?: string };
} {
  const entity = String(
    payload.entity ??
      (Array.isArray(payload.display_names) ? payload.display_names[0] : undefined) ??
      payload.ticker ??
      ""
  ).trim();
  const companyName = entity || undefined;

  let annualRevenue: number | undefined;
  const facts = payload.facts as Record<string, unknown> | undefined;
  if (facts) {
    const gaap = facts["us-gaap"] as Record<string, unknown> | undefined;
    const revenues = gaap?.Revenues as { units?: { USD?: Array<{ val?: number }> } } | undefined;
    const latest = revenues?.units?.USD?.at(-1)?.val;
    if (typeof latest === "number" && latest > 0) annualRevenue = latest;
  }

  const revField = payload.revenues ?? payload.annualRevenue;
  if (!annualRevenue && typeof revField === "number") annualRevenue = revField;

  const filed = payload.file_date ?? payload.filed;
  const form = String(payload.form_type ?? payload.form ?? "");

  return {
    companyName,
    annualRevenue,
    isPublic: /10-K|10-Q|8-K/i.test(form) || Boolean(companyName),
    funding: filed
      ? {
          lastRound: form.includes("8-K") ? "sec_filing" : undefined,
          lastRoundDate: String(filed).slice(0, 10),
        }
      : undefined,
  };
}
