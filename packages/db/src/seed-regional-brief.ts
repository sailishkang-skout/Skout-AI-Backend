import { createDb, type Db } from "./index.js";
import { schema } from "./index.js";
import { eq } from "drizzle-orm";

const { regions, countries, users, regionalBriefSlots, regionalBriefVersions } = schema;

type Category =
  | "market_economics"
  | "business_practice"
  | "channel_policy"
  | "telecom_requirements"
  | "data_compliance"
  | "explainability";

interface SeedRow {
  layerType: "global" | "country";
  countryIsoCode?: "US" | "GB";
  fieldCategory: Category;
  summary: string;
  details: string[];
  source: string;
  confidence: number;
  evidence: string;
}

const SEED_ROWS: SeedRow[] = [
  {
    layerType: "global",
    fieldCategory: "explainability",
    summary: "Regional selling brief entries carry source/confidence/evidence per row.",
    details: [
      "Anything below 70 confidence, or flagged 'needs legal review' in its evidence text, should not be treated as final guidance without human verification.",
    ],
    source: "Skout AI internal policy",
    confidence: 90,
    evidence: "Internal policy statement, not externally sourced.",
  },
  {
    layerType: "country",
    countryIsoCode: "US",
    fieldCategory: "market_economics",
    summary: "Typical B2B SaaS sales cycle ~84 days median; federal fiscal year Oct 1-Sep 30 drives an Aug-Sep public-sector budget-flush distinct from most companies' calendar-year planning.",
    details: [
      "SMB deals (<$15K ACV) close in 14-30 days, mid-market ($15K-$100K) in 30-90 days, enterprise (>$100K) in 90-180+ days.",
      "Federal FY is a well-established public fact (high confidence); cycle-length figures are directional vendor-benchmark aggregates only.",
    ],
    source: "Aggregated vendor benchmark blogs (Boomerang.ai, Gradient Works)",
    confidence: 55,
    evidence: "Cycle-length figures are private benchmark-report aggregations, not government/academic data — treat as directional only. Federal FY fact itself is high confidence.",
  },
  {
    layerType: "country",
    countryIsoCode: "US",
    fieldCategory: "business_practice",
    summary: "US buying culture is direct and efficiency-focused; buying committees average 6-11+ stakeholders on larger deals, with CFO involvement common above roughly $50K.",
    details: ["Disagreement/feedback in meetings is generally treated as normal, not face-threatening."],
    source: "Etiquette-training sources (Talaera, BoldVoice) + Gartner stakeholder-count figures cited secondhand",
    confidence: 55,
    evidence: "Gartner figures cited at one remove (via industry blogs, not a primary Gartner report) — verify before quoting an exact stakeholder count.",
  },
  {
    layerType: "country",
    countryIsoCode: "US",
    fieldCategory: "telecom_requirements",
    summary: "TCPA restricts telemarketing calls to 8:00 AM-9:00 PM in the called party's local time; B2B calls are generally exempt from the National Do Not Call Registry.",
    details: [
      "One narrow carve-out: telemarketing of nondurable office/cleaning supplies to businesses is NOT exempt from the DNC registry.",
      "Consent requirements for automated/prerecorded calls and texts are currently unsettled in the courts (conflicting 11th Circuit Jan 2025 and 5th Circuit Feb 2026 rulings) — do not treat any single consent standard as final without current legal review.",
    ],
    source: "TCPA (1991), FCC; FTC Telemarketing Sales Rule guidance; law-firm client alerts (Womble Bond Dickinson, Reed Smith)",
    confidence: 60,
    evidence: "The 8am-9pm window and B2B DNC exemption are well-corroborated (high confidence). The automated-call consent standard is actively contested in the courts as of mid-2026 — needs a current legal-review pass before being relied on.",
  },
  {
    layerType: "country",
    countryIsoCode: "US",
    fieldCategory: "data_compliance",
    summary: "CAN-SPAM (FTC) requires no misleading headers/subject lines, a valid physical postal address, a working opt-out honored within 10 business days and functional for 30+ days. Applies to B2B email, not just consumer.",
    details: [
      "Since Jan 2023, California's CCPA/CPRA no longer exempts B2B/employee data — a CA-resident business contact's work email/title is regulated personal information with access/deletion/opt-out rights.",
    ],
    source: "FTC 'CAN-SPAM Act: A Compliance Guide for Business'; law-firm alerts on CCPA's expired B2B exemption (Morgan Lewis, Katten)",
    confidence: 65,
    evidence: "FTC guidance substance is high confidence but was not re-verified against ftc.gov directly this pass (403 on automated fetch) — a human should open the FTC page directly before this is treated as final legal guidance. Do not publish a specific per-email penalty dollar figure without checking the current FTC-adjusted amount.",
  },
  {
    layerType: "country",
    countryIsoCode: "GB",
    fieldCategory: "market_economics",
    summary: "UK fiscal year runs April 1-March 31 (vs. US calendar-year norms), implying a March budget-flush period analogous to the US's Aug-Sep pattern.",
    details: ["No UK-specific SaaS sales-cycle or deal-size benchmark was found — do not reuse US figures for the UK."],
    source: "UK fiscal-year convention (gov.uk/HMRC), corroborated by Xero UK and IRIS Software glossaries",
    confidence: 50,
    evidence: "Fiscal-year fact itself is high confidence (uncontroversial). Budget-flush behavioral claim is an inference, not a UK-specific study.",
  },
  {
    layerType: "country",
    countryIsoCode: "GB",
    fieldCategory: "business_practice",
    summary: "UK business communication tends more indirect/diplomatic than the US — disagreement is often hedged rather than stated flatly. Hard-selling is viewed negatively.",
    details: [
      "Deals more often close over multiple meetings with written confirmation expected rather than in a single call.",
      "Meetings tend more formal, with agendas circulated in advance; relationship-building often happens outside the formal meeting.",
    ],
    source: "Cultural-etiquette sources (Globig, Commisceo Global, Cultural Atlas/SBS)",
    confidence: 50,
    evidence: "These are cultural-generalization/etiquette-training sources, not empirical research — treat as common pattern, not universal rule.",
  },
  {
    layerType: "country",
    countryIsoCode: "GB",
    fieldCategory: "telecom_requirements",
    summary: "PECR (2003) governs marketing calls/texts/emails alongside UK GDPR, regulated by the ICO. Live sales calls generally don't require prior consent unless the number is TPS-registered or has previously objected.",
    details: [
      "Screening call lists against the TPS before calling is described as a legal requirement, not best practice.",
      "The TPS-vs-CTPS (Corporate TPS) distinction for B2B numbers, and the exact calling-hours rule (UK guidance uses 'unsociable hours' language rather than a fixed clock window like the US TCPA), were not fully verified this pass — flagged for follow-up.",
    ],
    source: "ICO PECR guidance (via secondary corroboration)",
    confidence: 45,
    evidence: "ICO's own page returned an access error to automated fetch during research — a human should read https://ico.org.uk/for-organisations/direct-marketing-and-privacy-and-electronic-communications/guidance-on-direct-marketing-using-live-calls/ directly before this is finalized.",
  },
  {
    layerType: "country",
    countryIsoCode: "GB",
    fieldCategory: "data_compliance",
    summary: "PECR's 'corporate subscriber' exemption generally permits unsolicited B2B marketing email to generic company addresses (e.g. info@company.com) without consent.",
    details: [
      "This exemption likely does NOT extend cleanly to a named individual's work email (e.g. john.smith@company.com) — that may count as an 'individual subscriber' under PECR, and UK GDPR's lawful-basis requirement applies to that person's data regardless.",
      "This is the single most commonly-misunderstood point in this dataset and needs a direct legal-review read of ICO's B2B marketing guidance before being relied on.",
    ],
    source: "Secondary legal commentary (ConsentTrail, Geldards, Evalian)",
    confidence: 40,
    evidence: "Sources corroborate each other but were not independently verified against ICO's primary page (https://ico.org.uk/for-organisations/direct-marketing-and-privacy-and-electronic-communications/business-to-business-marketing/) this pass — required reading before this row is trusted as final.",
  },
];

async function main() {
  const databaseUrl = process.env.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5432/skout";
  const { db } = createDb(databaseUrl);

  const americas = await upsertRegion(db, "AMERICAS", "Americas");
  const emea = await upsertRegion(db, "EMEA", "Europe, Middle East & Africa");
  const us = await upsertCountry(db, "US", "United States", americas.id, "USD");
  const gb = await upsertCountry(db, "GB", "United Kingdom", emea.id, "GBP");
  const countryByIso = { US: us, GB: gb };

  const [existingAuthor] = await db.select().from(users).where(eq(users.email, "regional-brief-seed@skoutai.internal"));
  const author =
    existingAuthor ??
    (await db.insert(users).values({ email: "regional-brief-seed@skoutai.internal", fullName: "Regional Brief Seed" }).returning())[0]!;

  for (const row of SEED_ROWS) {
    const countryId = row.countryIsoCode ? countryByIso[row.countryIsoCode].id : null;
    const regionId = row.countryIsoCode ? countryByIso[row.countryIsoCode].regionId : null;
    const scopeKey =
      row.layerType === "global" ? `global:${row.fieldCategory}` : `country:${countryId}:${row.fieldCategory}`;

    const [existingSlot] = await db.select().from(regionalBriefSlots).where(eq(regionalBriefSlots.scopeKey, scopeKey));
    if (existingSlot?.currentVersionId) {
      console.log(`Skipping ${scopeKey} — already seeded.`);
      continue;
    }

    const slot =
      existingSlot ??
      (
        await db
          .insert(regionalBriefSlots)
          .values({
            layerType: row.layerType,
            regionId,
            countryId,
            fieldCategory: row.fieldCategory,
            scopeKey,
          })
          .returning()
      )[0]!;

    const [version] = await db
      .insert(regionalBriefVersions)
      .values({
        slotId: slot.id,
        version: 1,
        content: { summary: row.summary, details: row.details },
        source: row.source,
        effectiveDate: new Date(),
        confidence: row.confidence,
        evidence: row.evidence,
        status: "approved",
        reviewerId: author.id,
        reviewedAt: new Date(),
        createdBy: author.id,
      })
      .returning();

    await db.update(regionalBriefSlots).set({ currentVersionId: version!.id }).where(eq(regionalBriefSlots.id, slot.id));
    console.log(`Seeded ${scopeKey}`);
  }
}

async function upsertRegion(db: Db, code: string, name: string) {
  const [existing] = await db.select().from(regions).where(eq(regions.code, code));
  if (existing) return existing;
  const [created] = await db.insert(regions).values({ code, name }).returning();
  return created!;
}

async function upsertCountry(db: Db, isoCode: string, name: string, regionId: string, currencyCode: string) {
  const [existing] = await db.select().from(countries).where(eq(countries.isoCode, isoCode));
  if (existing) return existing;
  const [created] = await db.insert(countries).values({ isoCode, name, regionId, currencyCode }).returning();
  return created!;
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
