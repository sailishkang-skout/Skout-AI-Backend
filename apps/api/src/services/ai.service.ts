import OpenAI from "openai";
import { createLogger } from "@skout/observability";
import type { WorkspaceToolRunner } from "./ai-workspace-tools.service.js";

const log = createLogger("ai.service");

const SYSTEM_PROMPT = `You are an expert B2B sales email copywriter.
Generate a professional cold outreach email template in HTML format.

Merge tokens — use ONLY these exact placeholders, and only where appropriate:
  {{firstName}}   → the recipient's first name (use in the greeting)
  {{fullName}}    → the recipient's full name
  {{companyName}} → the recipient's company
  {{title}}       → the recipient's job title
  {{senderName}}  → YOUR name (use in the sign-off)
  {{unsubscribeUrl}} → the unsubscribe link

Rules:
- NEVER invent or hardcode names, companies, or roles. Do NOT write square-bracket
  placeholders like [Your Name], [Your Position], [Company], [Product] — use the merge
  tokens above instead (e.g. sign off with {{senderName}}). If you don't have a value,
  use the appropriate {{token}} — never a bracketed placeholder or a made-up value.
- Do NOT name the sender's company or product; keep the sender identity to {{senderName}}.
- The greeting must be "Hi {{firstName}}," (never "Hi [Name]," or a literal name).
- Return ONLY a valid JSON object (no markdown, no code fences) with exactly two keys:
    "subject": plain-text subject line, max 80 characters (tokens allowed, no brackets)
    "html": the email body as HTML — no <html>, <head>, or <body> wrapper tags
- HTML must use only clean inline-friendly tags: <p>, <strong>, <em>, <a>, <br>, <ul>, <li>
- Keep the email concise: 3–5 short paragraphs
- Always end with an unsubscribe paragraph: <p style="font-size:11px;color:#888"><a href="{{unsubscribeUrl}}">Unsubscribe</a></p>
- Tone: professional, personable, not spammy`;

const SEQUENCE_SYSTEM_PROMPT = `You are an expert B2B outbound sequence strategist.
Design a multi-step outreach cadence (email + optional LinkedIn touches) as JSON.

Merge tokens — use ONLY these exact placeholders in subjects and bodies:
  {{firstName}} {{fullName}} {{companyName}} {{title}} {{senderName}} {{unsubscribeUrl}}
Never invent names/companies or use square-bracket placeholders like [Your Name].

Return ONLY a valid JSON object (no markdown, no code fences) with exactly:
  "name": short human sequence name (max 60 chars)
  "steps": array of steps, each with:
    "stepType": "email" | "linkedin" | "wait"
    "delayDays": integer >= 0 (days to wait AFTER the previous step; first step is 0)
    "delayUnit": "days" (always use "days")
    "linkedinAction": "connect" | "message"   (ONLY when stepType is "linkedin")
    "subject": subject line (ONLY for "email"; max 80 chars; tokens allowed; no brackets)
    "bodyTemplate": HTML body for "email", or a short plain-text message for "linkedin".
       Use only <p>, <strong>, <em>, <a>, <br>, <ul>, <li>. No wrapper tags.

Rules:
- 4 to 6 steps total. Vary the angle across touches; do not repeat the same pitch.
- First email step delayDays = 0. Space later steps 2–4 days apart.
- Every email body must end with: <p style="font-size:11px;color:#888"><a href="{{unsubscribeUrl}}">Unsubscribe</a></p>
- Greeting must be "Hi {{firstName}},". Sign off with {{senderName}}.
- Keep copy concise and deliverability-safe (avoid spam-trigger words).`;

export interface GeneratedSequenceStep {
  stepType: "email" | "linkedin" | "wait";
  delayDays: number;
  delayUnit?: "minutes" | "hours" | "days" | "weeks";
  linkedinAction?: "connect" | "message";
  subject?: string;
  bodyTemplate?: string;
}

export interface GeneratedSequence {
  name: string;
  steps: GeneratedSequenceStep[];
}

export type ChartKind = "pie" | "bar" | "line" | "area" | "table" | "metric";

/**
 * A single visualization the frontend can render. `data` holds the already-aggregated rows the
 * model built from tool results; the frontend just draws them (no server-side rendering).
 */
export interface ChartSpec {
  kind: ChartKind;
  title: string;
  description?: string;
  /** Row objects, e.g. [{ label: "search", value: 120 }, …]. */
  data: Array<Record<string, string | number | null>>;
  /** Field used for the category / x-axis (pie/bar/line/area). */
  xKey?: string;
  /** Numeric field(s) to plot as series/values. */
  yKeys?: string[];
  /** Column definitions for kind "table". */
  columns?: Array<{ key: string; label: string }>;
  /** Single headline number for kind "metric". */
  value?: string | number;
  unit?: string;
}

export type ChatAction =
  | { type: "none" }
  | { type: "email"; subject: string; html: string }
  | { type: "sequence"; name: string; steps: GeneratedSequenceStep[] }
  | { type: "analysis"; title?: string; summary?: string; charts: ChartSpec[] };

const CHAT_SYSTEM_PROMPT = `You are Skout AI — the in-app assistant for this workspace.

You do three jobs:
1) Answer questions about THIS workspace using live data. You have TOOLS that read any workspace
   data on demand (overview, credit analytics + usage by action, credit ledger, lists & members,
   ICP, sequences & their analytics, inboxes, threads/messages, deliverability, AI drafts,
   integrations, team, invoices). ALWAYS call the relevant tool to get real numbers before
   answering a data question — never guess or invent numbers. The "Workspace facts" block (if
   present) is only a quick summary; prefer tools for anything specific (e.g. credit usage by
   week/category, a list's members, a sequence's reply rate).
2) Answer how-to questions about the Skout product using the "Product guides" block. Point users
   to the right in-app path (e.g. /import, /lists, /sequences, /ai/review, /settings/workspace).
3) Help write outbound email templates and multi-step sequences when asked.

Tool use rules:
- Call tools whenever a question depends on workspace data. You may call several tools (in sequence)
  to gather what you need, then give ONE final answer.
- For credit usage breakdowns (e.g. "credit usage by week" or a pie chart), call get_credit_analytics
  — its "credits.byAction" is the spend per category and "credits.daily" is the daily series.
- To EXPORT / download data as CSV, call export_dataset. The download link is delivered to the user
  automatically — do not paste CSV rows into your reply; just confirm the export is ready.
- If a tool returns an error or no data, say so plainly — do not fabricate values.

Charts & analysis:
- When the user asks for a chart, graph, pie/bar/line chart, dashboard, breakdown, or visual
  analysis, first fetch the real data with tools, then return an "analysis" action containing one or
  more chart specs built from that data. Also give a short natural-language "summary" of what the
  data shows in the "reply".
- Choose the right chart kind: "pie" for share/composition (e.g. credits by action), "bar" for
  comparisons across categories, "line"/"area" for trends over time (e.g. daily/weekly credit spend),
  "table" for detailed rows, "metric" for a single headline number.
- Never invent data points — every value in a chart must come from a tool result.

For product questions not covered by guides, give a short best-effort answer and suggest /guides.
When a Product guides section is provided, use it as the source of truth — do not say you lack
instructions if the guide already answers the question.

Merge tokens — use ONLY these in any subject/body you generate:
  {{firstName}} {{fullName}} {{companyName}} {{title}} {{senderName}} {{unsubscribeUrl}}
Never invent names/companies or use square-bracket placeholders like [Your Name].

Always reply with ONLY a valid JSON object (no markdown, no code fences):
  "reply": a short conversational message (answer, clarification, or suggestion). Use plain text;
       you may mention paths like /import or /guides/import-prospects.
  "action": one of:
    { "type": "none" }  — Q&A, how-tos, workspace facts, clarifying questions
    { "type": "email", "subject": "...", "html": "..." }  — when the user wants an email/template.
       html uses only <p>,<strong>,<em>,<a>,<br>,<ul>,<li>; greeting "Hi {{firstName}},";
       sign off {{senderName}}; end with the unsubscribe paragraph:
       <p style="font-size:11px;color:#888"><a href="{{unsubscribeUrl}}">Unsubscribe</a></p>
    { "type": "sequence", "name": "...", "steps": [ ... ] }  — when the user wants a cadence.
       Each step: { "stepType": "email"|"linkedin"|"wait", "delayDays": int>=0, "delayUnit": "days",
       "linkedinAction": "connect"|"message" (linkedin only),
       "subject": "..." (email only), "bodyTemplate": "..." (email HTML / linkedin plain text) }.
       4–6 steps, first delayDays 0, later steps 2–4 days apart.
    { "type": "analysis", "title": "...", "summary": "...", "charts": [ ... ] }  — when the user
       wants a chart/graph/visual breakdown/dashboard. Each chart:
       { "kind": "pie"|"bar"|"line"|"area"|"table"|"metric", "title": "...",
         "data": [ { ... } ],           // rows built from tool results
         "xKey": "category-field",       // category/x-axis key (pie/bar/line/area)
         "yKeys": ["value-field"],       // numeric series key(s)
         "columns": [ { "key": "...", "label": "..." } ],  // for "table"
         "value": 123, "unit": "credits" }.               // for "metric"
       Example pie for credits by action:
       { "kind": "pie", "title": "Credit usage by action", "xKey": "action", "yKeys": ["credits"],
         "data": [ { "action": "enrichment", "credits": 120 }, { "action": "search", "credits": 40 } ] }

If the user asks to tweak the current subject/body provided in context, return an "email" action
with the full revised version. Keep copy concise and deliverability-safe.
For pure Q&A (credits, how to import, what is AI Review, etc.) always use action type "none".`;

function coerceChatAction(raw: unknown): ChatAction {
  if (!raw || typeof raw !== "object") return { type: "none" };
  const r = raw as Record<string, unknown>;
  if (r.type === "email") {
    const subject = typeof r.subject === "string" ? r.subject : "";
    const html = typeof r.html === "string" ? r.html : "";
    if (!html) return { type: "none" };
    return { type: "email", subject, html };
  }
  if (r.type === "sequence") {
    const stepsRaw = Array.isArray(r.steps) ? r.steps : [];
    const steps = stepsRaw
      .map(coerceStep)
      .filter((s): s is GeneratedSequenceStep => s !== null);
    if (steps.length === 0) return { type: "none" };
    steps[0]!.delayDays = 0;
    const name =
      typeof r.name === "string" && r.name.trim()
        ? r.name.trim().slice(0, 60)
        : "AI-generated sequence";
    return { type: "sequence", name, steps };
  }
  if (r.type === "analysis") {
    const chartsRaw = Array.isArray(r.charts) ? r.charts : [];
    const charts = chartsRaw
      .map(coerceChart)
      .filter((c): c is ChartSpec => c !== null)
      .slice(0, 8);
    if (charts.length === 0) return { type: "none" };
    const action: Extract<ChatAction, { type: "analysis" }> = { type: "analysis", charts };
    if (typeof r.title === "string" && r.title.trim()) action.title = r.title.trim().slice(0, 120);
    if (typeof r.summary === "string" && r.summary.trim())
      action.summary = r.summary.trim().slice(0, 2000);
    return action;
  }
  return { type: "none" };
}

const CHART_KINDS: ChartKind[] = ["pie", "bar", "line", "area", "table", "metric"];
const MAX_CHART_ROWS = 200;

function coerceChart(raw: unknown): ChartSpec | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const kind = CHART_KINDS.includes(r.kind as ChartKind) ? (r.kind as ChartKind) : "bar";
  const title = typeof r.title === "string" && r.title.trim() ? r.title.trim().slice(0, 120) : "Chart";

  const dataRaw = Array.isArray(r.data) ? r.data : [];
  const data = dataRaw
    .filter((row): row is Record<string, unknown> => !!row && typeof row === "object")
    .slice(0, MAX_CHART_ROWS)
    .map((row) => {
      const clean: Record<string, string | number | null> = {};
      for (const [k, v] of Object.entries(row)) {
        clean[k] = typeof v === "number" || v === null ? v : String(v);
      }
      return clean;
    });

  // metric charts may carry only a headline value; everything else needs rows.
  if (kind !== "metric" && data.length === 0) return null;

  const chart: ChartSpec = { kind, title, data };
  if (typeof r.description === "string" && r.description.trim())
    chart.description = r.description.trim().slice(0, 500);
  if (typeof r.xKey === "string") chart.xKey = r.xKey;
  if (Array.isArray(r.yKeys)) chart.yKeys = r.yKeys.filter((k): k is string => typeof k === "string");
  if (Array.isArray(r.columns)) {
    chart.columns = r.columns
      .filter((c): c is Record<string, unknown> => !!c && typeof c === "object")
      .map((c) => ({ key: String(c.key ?? ""), label: String(c.label ?? c.key ?? "") }))
      .filter((c) => c.key);
  }
  if (typeof r.value === "number" || typeof r.value === "string") chart.value = r.value;
  if (typeof r.unit === "string") chart.unit = r.unit;
  return chart;
}

function coerceStep(raw: unknown): GeneratedSequenceStep | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const stepType = r.stepType === "linkedin" || r.stepType === "wait" ? r.stepType : "email";
  const delayDays =
    typeof r.delayDays === "number" && Number.isFinite(r.delayDays) && r.delayDays >= 0
      ? Math.floor(r.delayDays)
      : 0;
  const step: GeneratedSequenceStep = { stepType, delayDays, delayUnit: "days" };
  if (stepType === "linkedin") {
    step.linkedinAction = r.linkedinAction === "message" ? "message" : "connect";
  }
  if (stepType === "email" && typeof r.subject === "string") step.subject = r.subject.slice(0, 200);
  if (
    (stepType === "email" || stepType === "linkedin") &&
    typeof r.bodyTemplate === "string" &&
    r.bodyTemplate.trim()
  ) {
    step.bodyTemplate = r.bodyTemplate;
  }
  return step;
}

export class AiService {
  /**
   * @param insights Optional compact summary of what has performed well for this workspace
   *   (reply/bounce rates, winning subject lines). Appended to the prompt so the model learns
   *   from past sent/bounced/replied outcomes.
   */
  async generateEmail(
    prompt: string,
    apiKey: string | undefined,
    insights?: string | null
  ): Promise<{ html: string; subject: string }> {
    if (!apiKey) {
      throw Object.assign(new Error("OpenRouter API key is not configured on this workspace"), {
        statusCode: 503,
      });
    }

    const client = new OpenAI({
      apiKey,
      baseURL: "https://openrouter.ai/api/v1",
      defaultHeaders: { "HTTP-Referer": "https://skoutai.io", "X-Title": "Skout AI" },
    });

    let raw: string;
    try {
      const result = await client.chat.completions.create({
        model: process.env.AI_MODEL ?? "openai/gpt-4o-mini",
        max_tokens: 1200,
        temperature: 0.7,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          {
            role: "user",
            content:
              `Generate a B2B cold outreach email for: ${prompt.trim()}` +
              (insights?.trim()
                ? `\n\nLearn from this workspace's own outreach results and mirror what works:\n${insights.trim()}`
                : ""),
          },
        ],
      });
      raw = result.choices[0]?.message?.content ?? "{}";
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error("ai.service: OpenAI call failed", { err });
      throw Object.assign(new Error(`AI generation failed: ${msg}`), { statusCode: 502 });
    }

    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      return {
        subject: typeof parsed.subject === "string" ? parsed.subject : "",
        html: typeof parsed.html === "string" ? parsed.html : raw,
      };
    } catch {
      return { subject: "", html: raw };
    }
  }

  /**
   * Conversational assistant for writing email templates and designing sequences. Returns a
   * natural-language reply plus an optional structured action the UI can apply (an email
   * subject/body, or a full sequence cadence). Never persists — the caller decides when to
   * commit (auto mode applies immediately; ask mode waits for user confirmation).
   */
  async chat(
    input: {
      messages: { role: "user" | "assistant"; content: string }[];
      context?: {
        subject?: string;
        body?: string;
        kind?: "email" | "sequence" | "general";
        page?: string;
      };
      insights?: string | null;
      workspaceFacts?: string | null;
      appGuides?: string | null;
      /** Optional read-only workspace tools the model may call to fetch live data on demand. */
      toolRunner?: WorkspaceToolRunner | null;
    },
    apiKey: string | undefined
  ): Promise<{ reply: string; action: ChatAction }> {
    if (!apiKey) {
      throw Object.assign(new Error("OpenRouter API key is not configured on this workspace"), {
        statusCode: 503,
      });
    }

    const client = new OpenAI({
      apiKey,
      baseURL: "https://openrouter.ai/api/v1",
      defaultHeaders: { "HTTP-Referer": "https://skoutai.io", "X-Title": "Skout AI" },
    });

    const contextLines: string[] = [];
    if (input.context?.kind) contextLines.push(`The user is working on: ${input.context.kind}.`);
    if (input.context?.page) contextLines.push(`Current page: ${input.context.page}`);
    if (input.context?.subject) contextLines.push(`Current subject: ${input.context.subject}`);
    if (input.context?.body) contextLines.push(`Current body:\n${input.context.body}`);
    if (input.workspaceFacts?.trim()) {
      contextLines.push(`Workspace facts (authoritative — do not invent beyond this):\n${input.workspaceFacts.trim()}`);
    }
    if (input.appGuides?.trim()) {
      contextLines.push(`Product guides (how Skout works):\n${input.appGuides.trim()}`);
    }
    if (input.insights?.trim()) contextLines.push(`What works for this workspace:\n${input.insights.trim()}`);

    const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
      { role: "system", content: CHAT_SYSTEM_PROMPT },
      ...(contextLines.length
        ? [{ role: "system" as const, content: contextLines.join("\n\n") }]
        : []),
      ...input.messages.map((m) => ({ role: m.role, content: m.content })),
    ];

    const toolRunner = input.toolRunner ?? null;
    const model = process.env.AI_MODEL ?? "openai/gpt-4o-mini";
    // Cap tool-calling rounds so a misbehaving model can't loop forever.
    const MAX_TOOL_ROUNDS = 6;

    let raw = "{}";
    try {
      for (let round = 0; ; round += 1) {
        // Tool rounds must NOT force json_object — providers reject / confuse tool_calls with
        // JSON mode. Only lock JSON on the final answer turn (no tools / after max rounds).
        const allowTools = Boolean(toolRunner) && round < MAX_TOOL_ROUNDS;
        const result = await client.chat.completions.create({
          model,
          max_tokens: 2500,
          temperature: 0.6,
          messages,
          ...(allowTools
            ? { tools: toolRunner!.tools, tool_choice: "auto" as const }
            : { response_format: { type: "json_object" as const } }),
        });

        const message = result.choices[0]?.message;
        const toolCalls = message?.tool_calls ?? [];

        if (allowTools && toolCalls.length > 0) {
          // Record the assistant turn that requested tools, then run each and feed results back.
          messages.push({
            role: "assistant",
            content: message?.content ?? null,
            tool_calls: toolCalls,
          });
          for (const call of toolCalls) {
            if (call.type !== "function") continue;
            let args: Record<string, unknown> = {};
            try {
              args = call.function.arguments ? JSON.parse(call.function.arguments) : {};
            } catch {
              args = {};
            }
            const output = await toolRunner!.run(call.function.name, args);
            messages.push({ role: "tool", tool_call_id: call.id, content: output });
          }
          continue;
        }

        raw = message?.content ?? "{}";
        break;
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error("ai.service: chat failed", { err });
      throw Object.assign(new Error(`AI chat failed: ${msg}`), { statusCode: 502 });
    }

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return { reply: raw.slice(0, 2000), action: { type: "none" } };
    }

    const reply = typeof parsed.reply === "string" ? parsed.reply : "";
    const action = coerceChatAction(parsed.action);
    return { reply, action };
  }

  /** Generates a multi-step outreach cadence from a goal + audience/style context. */
  async generateSequence(
    input: {
      goal: string;
      audience?: string | null;
      channels?: ("email" | "linkedin")[];
      insights?: string | null;
      styleExamples?: string | null;
    },
    apiKey: string | undefined
  ): Promise<GeneratedSequence> {
    if (!apiKey) {
      throw Object.assign(new Error("OpenRouter API key is not configured on this workspace"), {
        statusCode: 503,
      });
    }

    const client = new OpenAI({
      apiKey,
      baseURL: "https://openrouter.ai/api/v1",
      defaultHeaders: { "HTTP-Referer": "https://skoutai.io", "X-Title": "Skout AI" },
    });

    const channels = input.channels?.length ? input.channels : ["email"];
    const userContent = [
      `Goal: ${input.goal.trim()}`,
      `Allowed channels: ${channels.join(", ")}${channels.includes("linkedin") ? " (include 1–2 LinkedIn touches)" : " (email only — do NOT add linkedin steps)"}`,
      input.audience?.trim() ? `Target audience:\n${input.audience.trim()}` : null,
      input.styleExamples?.trim()
        ? `Reference the style of these past sequences from this workspace:\n${input.styleExamples.trim()}`
        : null,
      input.insights?.trim()
        ? `Mirror what has worked for this workspace:\n${input.insights.trim()}`
        : null,
    ]
      .filter(Boolean)
      .join("\n\n");

    let raw: string;
    try {
      const result = await client.chat.completions.create({
        model: process.env.AI_MODEL ?? "openai/gpt-4o-mini",
        max_tokens: 2500,
        temperature: 0.7,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: SEQUENCE_SYSTEM_PROMPT },
          { role: "user", content: userContent },
        ],
      });
      raw = result.choices[0]?.message?.content ?? "{}";
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error("ai.service: sequence generation failed", { err });
      throw Object.assign(new Error(`AI generation failed: ${msg}`), { statusCode: 502 });
    }

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      throw Object.assign(new Error("AI returned an unparseable sequence"), { statusCode: 502 });
    }

    const stepsRaw = Array.isArray(parsed.steps) ? parsed.steps : [];
    const allowLinkedin = channels.includes("linkedin");
    const steps = stepsRaw
      .map(coerceStep)
      .filter((s): s is GeneratedSequenceStep => s !== null)
      .filter((s) => allowLinkedin || s.stepType !== "linkedin");

    if (steps.length === 0) {
      throw Object.assign(new Error("AI returned no usable steps"), { statusCode: 502 });
    }
    // First step should fire immediately.
    steps[0]!.delayDays = 0;

    const name =
      typeof parsed.name === "string" && parsed.name.trim()
        ? parsed.name.trim().slice(0, 60)
        : "AI-generated sequence";

    return { name, steps };
  }
}

export const aiService = new AiService();
