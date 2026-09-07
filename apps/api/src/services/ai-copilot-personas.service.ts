/**
 * §8.13 SP-06 — AI copilots: persona decision + implementation.
 *
 * DECISION (documented here since this ticket asked for the call to be made and recorded before
 * building): "4 distinct copilots" means 4 system-prompt/tool-subset variants sharing the
 * existing chat backend — NOT 4 separate UI products or 4 separate backends. The vision doc's
 * actual requirement is that they *share one evidence ledger and policy layer*; it never asks for
 * 4 visually separate surfaces. The codebase already proves this pattern out for a different
 * axis (the `agent: "skout" | "dexter" | "cro"` parameter in ai.service.ts/ai-workspace-tools.
 * service.ts selects a system prompt and, for "cro", restricts the offered/dispatchable tool set
 * via CRO_AGENT_TOOLS) — this file adds the same mechanism along a second, orthogonal axis
 * (persona) rather than inventing a new one. `agent` and `persona` compose: `agent` still governs
 * real security/behavioral differences (cro's admin gate, dexter's voice-teammate tone); `persona`
 * only adds a role-specific framing on top and, where declared, narrows the tool set further.
 *
 * Because persona restriction is enforced through the exact same `evidenceClaim`/
 * `classifyAndRecord` call sites every tool handler already goes through (this file only ever
 * narrows *which* tools are reachable, never how a reachable tool executes), every persona
 * shares one evidence ledger and one policy layer by construction — there is no persona-specific
 * evidence or policy code path to audit separately.
 *
 * First-cut scope: Sales and CRM Data are fully fleshed out (distinct system-prompt framing +,
 * for CRM Data, a real tool-subset restriction). Meeting/Call and GTM Strategy exist in the
 * registry and are selectable — the mechanism covers all 4 — but carry only a minimal prompt and
 * no tool restriction yet, per the ticket's explicit "even if only 1-2 personas are fully fleshed
 * out" allowance.
 */

export const COPILOT_PERSONAS = ["sales", "crm_data", "meeting_call", "gtm_strategy"] as const;
export type CopilotPersona = (typeof COPILOT_PERSONAS)[number];

export interface CopilotPersonaDef {
  id: CopilotPersona;
  label: string;
  description: string;
  /** Prepended to the base (agent-selected) system prompt — composes, never replaces. */
  systemPromptFragment: string;
  /** Tool names this persona may see/call. Undefined = no additional restriction (full set). */
  allowedToolNames?: readonly string[];
  /** False for personas not yet fully scoped in this cut — still selectable, minimal prompt only. */
  fleshedOut: boolean;
}

const CRM_DATA_TOOLS = [
  "get_prospect",
  "get_thread",
  "get_list_detail",
  "get_workspace_overview",
  "export_dataset",
  "explain_score",
] as const;

export const COPILOT_PERSONA_DEFS: Record<CopilotPersona, CopilotPersonaDef> = {
  sales: {
    id: "sales",
    label: "Sales",
    description: "Finds accounts, builds lists, drafts outreach, and launches sequences.",
    systemPromptFragment:
      "You are acting as the Sales Copilot persona: focus on finding and qualifying accounts, drafting outreach, and moving prospects into active sequences. Prioritize action over analysis.",
    fleshedOut: true,
  },
  crm_data: {
    id: "crm_data",
    label: "CRM Data",
    description: "Looks up and explains prospect, thread, and list data — read-only, no outreach actions.",
    systemPromptFragment:
      "You are acting as the CRM Data Copilot persona: answer questions about existing prospects, threads, lists, and scores with precision and cite what you looked up. You do not draft content or launch sequences — if asked to, say that's outside this persona and suggest switching to Sales.",
    allowedToolNames: CRM_DATA_TOOLS,
    fleshedOut: true,
  },
  meeting_call: {
    id: "meeting_call",
    label: "Meeting/Call",
    description: "Meeting and call follow-up assistant. Not fully scoped yet — placeholder prompt only.",
    systemPromptFragment:
      "You are acting as the Meeting/Call Copilot persona. This persona is an early placeholder — behave as the general assistant until meeting/call-specific tooling is built.",
    fleshedOut: false,
  },
  gtm_strategy: {
    id: "gtm_strategy",
    label: "GTM Strategy",
    description: "GTM planning and performance-summary assistant. Not fully scoped yet — placeholder prompt only.",
    systemPromptFragment:
      "You are acting as the GTM Strategy Copilot persona. This persona is an early placeholder — behave as the general assistant until GTM-strategy-specific tooling is built.",
    fleshedOut: false,
  },
};

export function isCopilotPersona(value: unknown): value is CopilotPersona {
  return typeof value === "string" && (COPILOT_PERSONAS as readonly string[]).includes(value);
}

export function getCopilotPersonaDef(persona: CopilotPersona | undefined): CopilotPersonaDef | null {
  return persona ? COPILOT_PERSONA_DEFS[persona] : null;
}

/** Composes a persona's framing on top of the agent-selected base system prompt. Pure and
 * side-effect-free so the composition logic can be unit-tested without mocking the OpenAI SDK. */
export function composeSystemPrompt(baseSystemPrompt: string, persona: CopilotPersona | undefined): string {
  const personaDef = getCopilotPersonaDef(persona);
  return personaDef ? `${personaDef.systemPromptFragment}\n\n${baseSystemPrompt}` : baseSystemPrompt;
}
