import type { Db } from "@skout/db";
import { schema } from "@skout/db";
import { createLogger } from "@skout/observability";
import type { Env } from "../config/env.js";
import { pinAiClaim } from "./ai-evidence.service.js";
import { renderTemplate } from "./workbook-column-template.js";
import type { WorkbookColumnRecord } from "./workbook-column.service.js";

const { workbookColumnValues } = schema;
const log = createLogger("workbook-column-compute");

/** Direct-LLM call for a per-cell research prompt — same OpenRouter pattern as
 * enrichment/ai-client.ts's scoreWithLLM, but free-text output (no JSON schema), since a
 * research answer isn't a fixed-shape classification. No Python AI-service round trip: this
 * column type is new and self-contained to apps/api, per the design doc. */
async function callAiResearch(config: Env, prompt: string): Promise<string> {
  if (!config.OPENROUTER_API_KEY) {
    throw new Error("ai_not_configured");
  }
  const { default: OpenAI } = await import("openai");
  const client = new OpenAI({
    apiKey: config.OPENROUTER_API_KEY,
    baseURL: "https://openrouter.ai/api/v1",
    timeout: config.ENRICHMENT_AI_TIMEOUT_MS,
    defaultHeaders: { "HTTP-Referer": "https://skoutai.io", "X-Title": "Skout AI" },
  });
  const model = process.env.AI_MODEL ?? "openai/gpt-4o-mini";
  const res = await client.chat.completions.create({
    model,
    messages: [
      {
        role: "system",
        content: "You are a sales research assistant. Answer the research question concisely in plain text, based only on the context given. If you don't have enough information, say so plainly rather than guessing.",
      },
      { role: "user", content: prompt },
    ],
  });
  const text = res.choices[0]?.message?.content?.trim();
  if (!text) throw new Error("ai_empty_response");
  return text;
}

async function writeValue(
  db: Db,
  params: {
    workspaceId: string;
    workbookRunId: string;
    columnDefinitionId: string;
    prospectId: string;
    status: "succeeded" | "failed";
    value?: string;
    evidenceId?: string;
    error?: string;
  }
): Promise<void> {
  await db
    .insert(workbookColumnValues)
    .values({
      workspaceId: params.workspaceId,
      workbookRunId: params.workbookRunId,
      columnDefinitionId: params.columnDefinitionId,
      prospectId: params.prospectId,
      status: params.status,
      value: params.value ?? null,
      evidenceId: params.evidenceId ?? null,
      error: params.error ?? null,
      computedAt: new Date(),
    })
    .onConflictDoNothing();
}

/**
 * §8.3 Task ADI-12 — computes every flexible column for one row, in `order_index` order, after
 * the existing PAL waterfall has already run for this prospect (see workbook-run.runner.ts).
 * `fieldContext` supplies the fixed-field values this row just produced (company/email/phone/
 * etc. — see buildFieldContext in workbook-run.runner.ts); each column's own computed value is
 * folded into the context for subsequent columns, so a later column may reference an earlier
 * one (this is also why columns can only reference earlier `order_index` values — see
 * workbook-column.service.ts's creation-time validation, which makes forward-reference cycles
 * structurally impossible rather than something this function needs to detect at runtime).
 *
 * Never throws — a column failing (missing reference, AI call error) writes a "failed" cell and
 * moves on, matching this codebase's existing per-field non-blocking-failure posture.
 */
export async function computeColumnsForRow(
  db: Db,
  config: Env,
  workspaceId: string,
  workbookRunId: string,
  columns: WorkbookColumnRecord[],
  prospectId: string,
  fieldContext: Record<string, string | undefined>
): Promise<void> {
  const context: Record<string, string | undefined> = { ...fieldContext };

  for (const column of columns) {
    try {
      if (column.columnType === "derived") {
        const { template } = column.config as { template: string };
        const { rendered, missingKeys } = renderTemplate(template, context);
        if (missingKeys.length > 0) {
          await writeValue(db, {
            workspaceId,
            workbookRunId,
            columnDefinitionId: column.id,
            prospectId,
            status: "failed",
            error: `missing reference(s): ${missingKeys.join(", ")}`,
          });
          continue;
        }
        await writeValue(db, {
          workspaceId,
          workbookRunId,
          columnDefinitionId: column.id,
          prospectId,
          status: "succeeded",
          value: rendered,
        });
        context[column.key] = rendered;
      } else {
        const { promptTemplate } = column.config as { promptTemplate: string };
        const { rendered: prompt, missingKeys } = renderTemplate(promptTemplate, context);
        if (missingKeys.length > 0) {
          await writeValue(db, {
            workspaceId,
            workbookRunId,
            columnDefinitionId: column.id,
            prospectId,
            status: "failed",
            error: `missing reference(s): ${missingKeys.join(", ")}`,
          });
          continue;
        }

        const answer = await callAiResearch(config, prompt);
        const pinned = await pinAiClaim(db, {
          workspaceId,
          entityType: "prospect",
          entityId: prospectId,
          attribute: column.key,
          value: answer,
          source: "workbook_ai_research",
          method: "workbook_column_compute",
          versionName: "workbook-ai-research",
        });
        await writeValue(db, {
          workspaceId,
          workbookRunId,
          columnDefinitionId: column.id,
          prospectId,
          status: "succeeded",
          value: answer,
          evidenceId: pinned.evidenceId,
        });
        context[column.key] = answer;
      }
    } catch (err) {
      log.warn("workbook column computation failed", { workbookRunId, columnId: column.id, prospectId, err });
      await writeValue(db, {
        workspaceId,
        workbookRunId,
        columnDefinitionId: column.id,
        prospectId,
        status: "failed",
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
