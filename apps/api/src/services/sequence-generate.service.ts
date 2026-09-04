import { eq, sql } from "drizzle-orm";
import type { Db } from "@skout/db";
import { schema, scopedTo } from "@skout/db";
import type { Env } from "../config/env.js";
import { aiService } from "./ai.service.js";
import { pinAiClaim } from "./ai-evidence.service.js";
import { SequenceService } from "./sequence.service.js";
import { computeOutcomeInsights, insightsToPrompt } from "./outcome-insights.service.js";

const { listMembers, prospectActivations } = schema;

export interface GenerateSequenceInput {
  goal: string;
  listId?: string;
  channels?: ("email" | "linkedin")[];
}

const AUDIENCE_SAMPLE = 40;

function topValues(values: (string | undefined)[], limit: number): string[] {
  const counts = new Map<string, number>();
  for (const v of values) {
    const t = v?.trim();
    if (!t) continue;
    counts.set(t, (counts.get(t) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([v]) => v);
}

/** Builds a short audience summary from a list's members for AI targeting context. */
async function buildAudienceSummary(
  db: Db,
  workspaceId: string,
  listId: string
): Promise<string | null> {
  const rows = await db
    .select({ snapshot: prospectActivations.snapshot })
    .from(listMembers)
    .innerJoin(
      prospectActivations,
      scopedTo(prospectActivations, workspaceId, eq(prospectActivations.prospectId, listMembers.prospectId))
    )
    .where(eq(listMembers.listId, listId))
    .limit(AUDIENCE_SAMPLE);

  if (rows.length === 0) return null;

  const snaps = rows.map((r) => (r.snapshot ?? {}) as Record<string, unknown>);
  const str = (s: Record<string, unknown>, k: string) =>
    typeof s[k] === "string" ? (s[k] as string) : undefined;

  const titles = topValues(snaps.map((s) => str(s, "title")), 6);
  const industries = topValues(snaps.map((s) => str(s, "industry")), 4);
  const companies = topValues(
    snaps.map((s) => str(s, "companyName") ?? str(s, "companyDomain")),
    4
  );
  const seniorities = topValues(snaps.map((s) => str(s, "seniority")), 3);

  const parts = [`~${rows.length} prospects sampled from the list.`];
  if (titles.length) parts.push(`Common titles: ${titles.join(", ")}.`);
  if (seniorities.length) parts.push(`Seniority: ${seniorities.join(", ")}.`);
  if (industries.length) parts.push(`Industries: ${industries.join(", ")}.`);
  if (companies.length) parts.push(`Example companies: ${companies.join(", ")}.`);
  return parts.join(" ");
}

function stripHtml(html: string, max = 200): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function buildStyleExamples(
  examples: { name: string; steps: { stepType: string; subject: string | null; bodyTemplate: string | null }[] }[]
): string | null {
  const lines: string[] = [];
  for (const ex of examples) {
    const emailSteps = ex.steps.filter((s) => s.stepType === "email").slice(0, 2);
    if (emailSteps.length === 0) continue;
    lines.push(
      `"${ex.name}": ` +
        emailSteps
          .map((s) => `subject "${s.subject ?? ""}" — ${stripHtml(s.bodyTemplate ?? "")}`)
          .join(" | ")
    );
    if (lines.length >= 3) break;
  }
  return lines.length > 0 ? lines.join("\n") : null;
}

/**
 * Generates a draft sequence for a workspace: gathers audience (from a list), past-sequence
 * style, and outcome insights, asks the model for a multi-step cadence, and persists it as a
 * `draft` sequence with steps. Returns the created sequence with steps.
 */
export async function generateSequenceForWorkspace(
  db: Db,
  config: Env,
  workspaceId: string,
  input: GenerateSequenceInput
) {
  const seqSvc = new SequenceService(db);

  const [audience, styleExamplesRaw, insights] = await Promise.all([
    input.listId ? buildAudienceSummary(db, workspaceId, input.listId).catch(() => null) : null,
    seqSvc.getStyleExamples(workspaceId).catch(() => []),
    computeOutcomeInsights(db, workspaceId).catch(() => null),
  ]);

  const generated = await aiService.generateSequence(
    {
      goal: input.goal,
      audience,
      channels: input.channels,
      insights: insightsToPrompt(insights),
      styleExamples: buildStyleExamples(styleExamplesRaw),
    },
    config.OPENROUTER_API_KEY
  );

  const sequence = await seqSvc.createGeneratedSequence(workspaceId, {
    ...generated,
    source: "dexter",
    mode: "C",
  });

  await pinAiClaim(db, {
    workspaceId,
    entityType: "sequence",
    entityId: sequence.id,
    attribute: "ai_generated_cadence",
    value: {
      goal: input.goal,
      name: generated.name,
      stepCount: generated.steps?.length ?? 0,
      listId: input.listId ?? null,
    },
    source: "sequence_generate",
    method: "sequence_generate",
    versionName: "sequence-generate",
    confidence: 0.75,
  });

  return sequence;
}
