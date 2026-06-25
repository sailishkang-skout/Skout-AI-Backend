/** SEC companyfacts lookup for public-company revenue (used by sec-edgar bot). */
export async function fetchSecCompanyFacts(
  cikOrTicker: string
): Promise<Record<string, unknown> | null> {
  const ticker = cikOrTicker.trim().toUpperCase();
  if (!ticker) return null;

  try {
    const tickersRes = await fetch("https://www.sec.gov/files/company_tickers.json", {
      headers: { "User-Agent": process.env.SEC_EDGAR_USER_AGENT ?? "Skout AI contact@skout.ai" },
      signal: AbortSignal.timeout(15_000),
    });
    if (!tickersRes.ok) return null;
    const tickers = (await tickersRes.json()) as Record<
      string,
      { cik_str: number; ticker: string; title: string }
    >;
    const match = Object.values(tickers).find((t) => t.ticker === ticker);
    if (!match) return null;

    const cik = String(match.cik_str).padStart(10, "0");
    const factsRes = await fetch(`https://data.sec.gov/api/xbrl/companyfacts/CIK${cik}.json`, {
      headers: { "User-Agent": process.env.SEC_EDGAR_USER_AGENT ?? "Skout AI contact@skout.ai" },
      signal: AbortSignal.timeout(15_000),
    });
    if (!factsRes.ok) return null;
    const facts = (await factsRes.json()) as Record<string, unknown>;
    return { ...facts, entity: match.title, ticker: match.ticker, facts: facts.facts };
  } catch {
    return null;
  }
}
