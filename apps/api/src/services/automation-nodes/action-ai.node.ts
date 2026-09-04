import { buildAiDraftService } from "../ai-draft.service.js";
import { aiService } from "../ai.service.js";
import { HttpError } from "../../utils/http.js";
import type { NodeHandler } from "./types.js";

/**
 * §8.14 SP-08 — wraps the same Content Studio draft path the `draft_content` AI-copilot tool
 * uses (ai.service.ts's generateEmail + ai-draft.service.ts's create), so a workflow step and a
 * chat-driven draft request produce identical AI drafts, not two divergent generation paths.
 *
 * Config: { prospectId: string; prompt: string }.
 */
export const aiActionNodeHandler: NodeHandler = async (ctx) => {
  const { prospectId, prompt } = ctx.node.config as { prospectId?: string; prompt?: string };

  if (!prospectId || !prompt?.trim()) {
    throw new HttpError("AI action node requires both prospectId and prompt", 422);
  }

  if (ctx.isSimulation) {
    return { output: { simulated: true, prospectId, prompt } };
  }

  const generated = await aiService.generateEmail(prompt, ctx.config.OPENROUTER_API_KEY);
  const drafts = buildAiDraftService(ctx.db);
  const draft = await drafts.create(ctx.workspaceId, {
    prospectId,
    subject: generated.subject,
    body: generated.html,
    model: process.env.AI_MODEL ?? "openai/gpt-4o-mini",
  });

  return { output: { draftId: draft.id, subject: draft.subject, status: draft.status } };
};
