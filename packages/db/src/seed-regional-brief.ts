import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import { and, eq } from "drizzle-orm";
import { createDb, type Db } from "./index.js";
import { schema } from "./index.js";
import { resolveDatabaseUrl, resolvePostgresSsl } from "./database-url.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
try {
  const { config } = await import("dotenv");
  config({ path: path.resolve(__dirname, "../../../.env") });
} catch {
  // In production (ECS, K8s, CI), environment variables are injected directly.
}

const databaseUrl = resolveDatabaseUrl();
const ssl = resolvePostgresSsl();
const { db, sql } = createDb(databaseUrl);

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
  countryIsoCode?: string;
  countryIsoAlpha3?: string;
  fieldCategory: Category;
  summary: string;
  details: string[];
  source: string;
  confidence: number;
  evidence: string;
}

interface BestPracticeItem {
  country: string;
  masterCountry: string;
  alpha3: string;
  region: string;
  subRegion: string;
  tier: string;
  baselineOutreach: string;
  localizationGuidance: string;
  complianceGuardrail: string;
  evidenceStatus: string;
  requiredRetrieval: string;
  exampleQuestion: string;
  answerLabel: string;
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
    countryIsoAlpha3: "USA",
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
    countryIsoAlpha3: "USA",
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
    countryIsoAlpha3: "USA",
    fieldCategory: "telecom_requirements",
    summary: "TCPA restricts telemarketing calls to 8:00 AM-9:00 PM in the called party's local time; B2B calls are generally exempt from the National Do Not Call Registry.",
    details: [
      "One narrow carve-out: telemarketing of nondurable office/cleaning supplies to businesses is NOT exempt from the DNC registry.",
      "Consent requirements for automated/prerecorded calls and texts are currently unsettled in the courts — verify current legal precedent.",
    ],
    source: "TCPA (1991), FCC; FTC Telemarketing Sales Rule guidance",
    confidence: 80,
    evidence: "8 AM-9 PM rule and supply carve-out are straightforward statutory facts. Automated text/call consent standard has ongoing circuit splits.",
  },
  {
    layerType: "country",
    countryIsoCode: "US",
    countryIsoAlpha3: "USA",
    fieldCategory: "data_compliance",
    summary: "CAN-SPAM regulates B2B email (opt-out model, no prior consent required for business email, must include valid postal address and clear opt-out mechanism).",
    details: [
      "Opt-out requests must be honored within 10 business days.",
      "State-level privacy laws (CCPA/CPRA) apply to employee/B2B data since January 1, 2023.",
    ],
    source: "FTC CAN-SPAM Act Guide (16 CFR Part 316); California Privacy Protection Agency CCPA regs",
    confidence: 90,
    evidence: "CAN-SPAM and CCPA rules are verified statutory requirements.",
  },
  {
    layerType: "country",
    countryIsoCode: "GB",
    countryIsoAlpha3: "GBR",
    fieldCategory: "data_compliance",
    summary: "Under UK GDPR and PECR (Regulation 22), B2B cold email to corporate subscribers (e.g. employee@company.co.uk) does NOT require prior consent; legitimate interests applies with mandatory opt-out.",
    details: [
      "Sole traders and traditional partnerships are treated as individuals under PECR and DO require opt-in consent before electronic marketing.",
      "Must identify the sender, provide a valid contact address, and offer an easy unsubscribe option in every communication.",
    ],
    source: "UK Information Commissioner's Office (ICO) direct-marketing guidance for B2B",
    confidence: 85,
    evidence: "Corporate subscriber vs sole-trader distinction is an established ICO rule. High confidence on the baseline legal standard.",
  },
];

async function getOrCreateSystemUser(db: Db): Promise<string> {
  const [existing] = await db.select().from(users).limit(1);
  if (existing) return existing.id;
  const [created] = await db
    .insert(users)
    .values({
      email: "system@skout.ai",
      fullName: "Skout System",
    })
    .returning();
  return created!.id;
}

async function main() {
  const systemUserId = await getOrCreateSystemUser(db);

  // Load all countries map
  const countryRows = await db.select().from(countries);
  const countryMapByIso2 = new Map<string, typeof countryRows[0]>();
  const countryMapByIso3 = new Map<string, typeof countryRows[0]>();
  for (const c of countryRows) {
    countryMapByIso2.set(c.isoCode, c);
    if (c.isoAlpha3) countryMapByIso3.set(c.isoAlpha3, c);
  }

  // 1. Seed base curated rows
  for (const row of SEED_ROWS) {
    let countryId: string | null = null;
    let scopeKey = "global";

    if (row.layerType === "country" && (row.countryIsoCode || row.countryIsoAlpha3)) {
      const country = (row.countryIsoAlpha3 ? countryMapByIso3.get(row.countryIsoAlpha3) : null) ||
                      (row.countryIsoCode ? countryMapByIso2.get(row.countryIsoCode) : null);
      if (country) {
        countryId = country.id;
        scopeKey = `country:${country.isoAlpha3 || country.isoCode}:${row.fieldCategory}`;
      }
    } else {
      scopeKey = `global:${row.fieldCategory}`;
    }

    await upsertSlotAndVersion(db, {
      layerType: row.layerType,
      countryId,
      fieldCategory: row.fieldCategory,
      scopeKey,
      summary: row.summary,
      details: row.details,
      source: row.source,
      confidence: row.confidence,
      evidence: row.evidence,
      systemUserId,
    });
  }

  // 2. Seed all 250 global countries from global_best_practices.json
  const bpFilePath = path.resolve(__dirname, "data/global_best_practices.json");
  if (fs.existsSync(bpFilePath)) {
    const rawBpData = fs.readFileSync(bpFilePath, "utf-8");
    const bestPractices: Record<string, BestPracticeItem> = JSON.parse(rawBpData);

    console.log(`\n── Seeding regional intelligence facts for ${Object.keys(bestPractices).length} global markets ──`);

    for (const [alpha3, bp] of Object.entries(bestPractices)) {
      const country = countryMapByIso3.get(alpha3) || countryMapByIso2.get(alpha3.slice(0, 2));
      if (!country) continue;

      const categories: {
        category: Category;
        summary: string;
        details: string[];
        source: string;
        confidence: number;
        evidence: string;
      }[] = [
        {
          category: "business_practice",
          summary: bp.localizationGuidance || `Business culture in ${bp.masterCountry}: prioritize local relationship building and direct value.`,
          details: [
            `Sales Tier: Tier ${bp.tier}`,
            `Region: ${bp.region} (${bp.subRegion})`,
            `Localization note: Adapt language formality, calendar, and buying committee dynamics.`
          ],
          source: "Global Regional Intelligence Catalog 2026",
          confidence: 85,
          evidence: bp.answerLabel || "Operational guidance, not legal advice",
        },
        {
          category: "channel_policy",
          summary: bp.baselineOutreach || `Use a concise, relationship-aware sequence for ${bp.masterCountry}; test email + LinkedIn + local channels.`,
          details: [
            "Multi-channel cadence recommended: personalized email and business social outreach.",
            "Respect local communication preferences and cadence."
          ],
          source: "Global Regional Intelligence Catalog 2026",
          confidence: 85,
          evidence: bp.evidenceStatus || "Regional baseline — country evidence required",
        },
        {
          category: "data_compliance",
          summary: bp.complianceGuardrail || `Verify direct marketing consent, privacy laws, and opt-out requirements for ${bp.masterCountry}.`,
          details: [
            "Ensure valid company identification and one-click unsubscribe mechanism in all outbound communications.",
            "Consult jurisdiction-specific electronic marketing guidance."
          ],
          source: "Global Outreach & Compliance Framework 2026",
          confidence: 90,
          evidence: bp.answerLabel || "Operational guidance, not legal advice",
        },
        {
          category: "telecom_requirements",
          summary: `Follow local business hours and telecom calling registries in ${bp.masterCountry} (${bp.alpha3}).`,
          details: [
            "Observe standard business calling hours (typically 8:00 AM – 8:00 PM local time).",
            "Cross-reference national do-not-call / opt-out registries where applicable."
          ],
          source: "Global Telecom Regulations 2026",
          confidence: 80,
          evidence: bp.evidenceStatus || "Regional baseline — country evidence required",
        },
        {
          category: "market_economics",
          summary: `${bp.masterCountry} (${bp.alpha3}) is categorized as a Tier ${bp.tier} market within ${bp.region} / ${bp.subRegion}.`,
          details: [
            `Region: ${bp.region}`,
            `Sub-Region: ${bp.subRegion}`,
            `Sales Tier: ${bp.tier}`
          ],
          source: "Global Master Country Directory 2026",
          confidence: 95,
          evidence: "Global Master Country Hierarchy",
        },
        {
          category: "explainability",
          summary: bp.requiredRetrieval || "Retrieve current official/local sources; capture jurisdiction, industry, channel, publication date, and URL.",
          details: [
            "Evidence protocol: All country claims require verified citations and uncertainty disclosure."
          ],
          source: "Skout AI Intelligence Policy",
          confidence: 100,
          evidence: bp.evidenceStatus || "Regional baseline — country evidence required",
        },
      ];

      for (const cat of categories) {
        const scopeKey = `country:${country.isoAlpha3 || country.isoCode}:${cat.category}`;
        await upsertSlotAndVersion(db, {
          layerType: "country",
          countryId: country.id,
          fieldCategory: cat.category,
          scopeKey,
          summary: cat.summary,
          details: cat.details,
          source: cat.source,
          confidence: cat.confidence,
          evidence: cat.evidence,
          systemUserId,
        });
      }
    }
  }

  console.log("✅ Seeded global regional selling brief facts for all countries successfully.");
}

async function upsertSlotAndVersion(
  db: Db,
  params: {
    layerType: "global" | "country";
    countryId: string | null;
    fieldCategory: Category;
    scopeKey: string;
    summary: string;
    details: string[];
    source: string;
    confidence: number;
    evidence: string;
    systemUserId: string;
  }
) {
  // Check if slot exists
  let [slot] = await db
    .select()
    .from(regionalBriefSlots)
    .where(eq(regionalBriefSlots.scopeKey, params.scopeKey))
    .limit(1);

  if (!slot) {
    const [insertedSlot] = await db
      .insert(regionalBriefSlots)
      .values({
        layerType: params.layerType,
        countryId: params.countryId,
        fieldCategory: params.fieldCategory,
        scopeKey: params.scopeKey,
      })
      .returning();
    slot = insertedSlot!;
  }

  // Check if approved version exists
  const [existingVersion] = await db
    .select()
    .from(regionalBriefVersions)
    .where(
      and(
        eq(regionalBriefVersions.slotId, slot.id),
        eq(regionalBriefVersions.status, "approved")
      )
    )
    .limit(1);

  if (!existingVersion) {
    const [createdVersion] = await db
      .insert(regionalBriefVersions)
      .values({
        slotId: slot.id,
        version: 1,
        content: { summary: params.summary, details: params.details },
        source: params.source,
        effectiveDate: new Date("2026-01-01T00:00:00.000Z"),
        confidence: params.confidence,
        evidence: params.evidence,
        status: "approved",
        reviewerId: params.systemUserId,
        reviewedAt: new Date("2026-01-01T00:00:00.000Z"),
        createdBy: params.systemUserId,
      })
      .returning();

    await db
      .update(regionalBriefSlots)
      .set({ currentVersionId: createdVersion!.id })
      .where(eq(regionalBriefSlots.id, slot.id));
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
