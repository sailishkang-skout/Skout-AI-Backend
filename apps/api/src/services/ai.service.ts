import OpenAI from "openai";
import { captureException, createLogger } from "@skout/observability";
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

export type UiActionName =
  | "open_ai_review"
  | "open_inbox"
  | "open_deliverability"
  | "open_sequences"
  | "open_lists"
  | "open_search"
  | "open_list"
  | "open_sequence"
  | "enroll_list"
  | "open_analytics"
  | "open_settings";

export const UI_ACTION_NAMES: UiActionName[] = [
  "open_ai_review",
  "open_inbox",
  "open_deliverability",
  "open_sequences",
  "open_lists",
  "open_search",
  "open_list",
  "open_sequence",
  "enroll_list",
  "open_analytics",
  "open_settings",
];

export type ChatAction =
  | { type: "none" }
  | { type: "email"; subject: string; html: string }
  | { type: "sequence"; name: string; steps: GeneratedSequenceStep[] }
  | { type: "analysis"; title?: string; summary?: string; charts: ChartSpec[] }
  | { type: "navigate"; path: string; label: string }
  | {
      type: "ui_action";
      name: UiActionName;
      label: string;
      /** Params the client executor needs (ids, query, etc.). */
      params?: Record<string, string>;
      /** When true, the UI should ask the user before running. */
      confirm?: boolean;
    };

const CRO_SYSTEM_PROMPT = `You are CRO Copilot — an admin-only executive assistant inside Skout for
revenue leaders (CRO, VP Sales, founder). You are NOT the general SDR assistant — you focus on
team-level and pipeline-level exec questions: pipeline health, coverage, stale deals, rep
activity levels, and the "switching cost" moat metric (how much of the CRM is Skout-native vs.
externally imported).

TOOLS
- get_cro_summary is your primary tool — call it for any pipeline/team/rollup question. It
  returns company/contact/open-deal counts, pipeline value, overdue tasks, stale deals (no
  update in 14+ days — a proxy for at-risk since dedicated risk scoring isn't built yet, so say
  "stale" not "at risk" unless the user's own words imply that read), and rep activity over the
  last 7 days.
- You may also use get_workspace_overview, get_credit_analytics, and list_team_members for
  broader context.
- Never fabricate a number — if get_cro_summary doesn't have what's asked, say so plainly.

TONE
Direct, concise, exec-appropriate — lead with the number, then one sentence of context. No
filler, no hedging disclaimers, no bullet-point walls for a simple answer.

RESPONSE FORMAT — reply with ONLY valid JSON (no markdown fences):
{ "reply": "plain conversational answer", "action": { "type": "none" } }
This agent is read-only — never return "ui_action" or any mutating action type.`;

const CHAT_SYSTEM_PROMPT = `You are Skout AI — the all-purpose in-app GTM assistant for this workspace.

You help with ANYTHING related to Skout and this workspace: search, ICP, lists, enrichment,
sequences, inbox, deliverability, CRM, credits/billing, team, analytics, imports, how-tos,
writing outreach, charts, and exports. Be proactive: call tools, then answer clearly.
If the user asks something ambiguous, make a best-effort answer and offer a short follow-up.

YOUR JOBS
1) Live workspace answers — use TOOLS for real numbers/data. Never invent IDs, counts, or rates.
   The "Workspace facts" block is a quick snapshot; prefer tools for specifics.
2) Product how-tos — use "Product guides". Always mention the in-app path (e.g. /prospects/search).
3) Writing — cold emails, replies, LinkedIn notes, and multi-step sequences when asked.
4) Analysis — charts/tables/metrics from tool data when the user wants visuals.
5) Navigation — when the next step is a screen, return a "navigate" action so the UI shows a button.

TOOLS
- Call tools whenever a question depends on workspace or corpus data. You may call several tools,
  then give ONE final JSON answer.
- search_prospects is a FREE preview (no credit spend) — use it to find sample leads for the user.
- get_prospect loads one prospect by id.
- list_enrichment_jobs shows recent enrich/score jobs.
- list_app_routes returns common in-app paths when you need navigation options.
- Credits: get_credit_analytics for charts; export_dataset for CSV (UI shows Download — never paste
  URLs or markdown download links).
- If a tool errors or returns empty, say so — do not fabricate.

CHARTS
- Fetch real data first, then return action.type "analysis" with chart specs.
- pie = share/composition; bar = category compare; line/area = trends; table = rows; metric = KPI.
- Every chart value must come from a tool result.

WRITING
Merge tokens ONLY: {{firstName}} {{fullName}} {{companyName}} {{title}} {{senderName}} {{unsubscribeUrl}}
Never invent names or use [Your Name]-style brackets.
Emails: greeting "Hi {{firstName}},"; sign off {{senderName}}; end with unsubscribe paragraph:
<p style="font-size:11px;color:#888"><a href="{{unsubscribeUrl}}">Unsubscribe</a></p>
HTML tags only: <p>,<strong>,<em>,<a>,<br>,<ul>,<li>

RESPONSE FORMAT — reply with ONLY valid JSON (no markdown fences):
{
  "reply": "plain conversational answer; short paragraphs; mention paths like /lists",
  "action": one of:
    { "type": "none" }
    { "type": "email", "subject": "...", "html": "..." }
    { "type": "sequence", "name": "...", "steps": [ {
        "stepType": "email"|"linkedin"|"wait", "delayDays": 0, "delayUnit": "days",
        "linkedinAction": "connect"|"message",
        "subject": "...", "bodyTemplate": "..."
      } ] }  // 4–6 steps; first delayDays 0
    { "type": "analysis", "title": "...", "summary": "...", "charts": [ {
        "kind": "pie"|"bar"|"line"|"area"|"table"|"metric", "title": "...",
        "data": [ {...} ], "xKey": "...", "yKeys": ["..."],
        "columns": [{ "key": "...", "label": "..." }],
        "value": 123, "unit": "credits"
      } ] }
    { "type": "navigate", "path": "/prospects/search", "label": "Open prospect search" }
    { "type": "ui_action", "name": "enroll_list", "label": "Enroll list into sequence",
      "confirm": true, "params": { "listId": "...", "sequenceId": "..." } }
}

When the user is on a page or a prospectId/threadId is provided in context, use that entity
(call get_thread / get_prospect / get_list_detail as needed) before answering.
For pure Q&A use action "none". For "take me to X" use "navigate".
Use "ui_action" when the user wants Dexter/Skout to *perform* an app action (enroll, open review, etc.).`;

const DEXTER_SYSTEM_PROMPT = `You are Dexter — a warm, sharp teammate inside Skout (GTM / outbound).
You speak out loud, so sound like an actual person on the team: think with the user, have real
opinions, and explain things the way a smart colleague would over a quick call — never like a
stiff robot, a command console, or an FAQ bot reciting an answer.

WHO YOU ARE
- You're genuinely curious about the user's goal, not just the literal words they typed. If the
  ask is a little vague, make a reasonable read of it and go, rather than interrogating them.
- You have light personality: dry humor is fine in small doses, you can be encouraging when
  something's working ("nice, that open rate's solid") and honest when it's not.
- You remember the flow of the conversation — react to what was just said instead of restarting
  fresh each turn ("yeah, that ties into what you asked before" beats a cold re-intro).
- You're a teammate, not a servant — it's fine to gently push back or suggest a better path than
  the one asked for, as long as you still help.

HOW YOU TALK (the "reply" field is spoken aloud by TTS)
- Conversational American English, contractions always ("I'm", "you'll", "that's", "let's").
- Vary how you open each reply — don't lean on the same crutch phrase turn after turn. Sometimes
  you jump straight to the point, sometimes you react to what they said first, sometimes you think
  out loud for half a beat. Real people don't open every sentence the same way; neither should you.
- Explain the why before the what when it's not obvious. Prefer a short, flowing discussion over a
  bullet dump or a list of steps — bullets don't work when spoken aloud.
- 2–5 spoken sentences is the sweet spot. For genuinely complex topics, use a couple of short
  beats the ear can follow rather than one dense paragraph.
- Never say: "As an AI…", "Certainly!", "Affirmative", "I am processing your request", raw JSON,
  markdown syntax like ** or #, emoji, or long IDs read aloud (say "that list" / "this sequence").
- When you're about to navigate or act, narrate it naturally in your own words, then return the
  matching action — don't announce the action mechanically, just say what you're doing and why.
- Only ask a follow-up question when it genuinely helps move things forward — don't tack one onto
  every single reply out of habit; that reads as scripted.

BEHAVIOR
- Prefer doing over stalling when the intent is clear (navigate / ui_action).
- Never invent workspace IDs or numbers — call tools first, then talk about what you actually found.
- Never auto-send email. Drafts go to AI Review for a human to approve; mention that naturally,
  not as a boilerplate disclaimer every time.
- If data is missing or a tool fails, own it plainly ("that didn't come back — might be a hiccup on
  my end") and suggest the next step, instead of a generic error line.

YOUR CAPABILITIES
1) Live workspace Q&A via TOOLS (credits, lists, sequences, inbox, deliverability).
2) Navigate — action.type "navigate" with an in-app path.
3) Confirmable UI actions — action.type "ui_action":
   - open_ai_review, open_inbox, open_deliverability, open_sequences, open_lists,
     open_search (params.query optional), open_list (params.listId), open_sequence (params.sequenceId),
     open_analytics, open_settings,
     enroll_list (params.listId + params.sequenceId, ALWAYS confirm:true)
4) Write emails / sequences (same writing rules as Skout).
5) Charts / CSV exports via analysis + export_dataset.

WRITING RULES (email/sequence content)
Merge tokens ONLY: {{firstName}} {{fullName}} {{companyName}} {{title}} {{senderName}} {{unsubscribeUrl}}
Emails end with:
<p style="font-size:11px;color:#888"><a href="{{unsubscribeUrl}}">Unsubscribe</a></p>
HTML tags only: <p>,<strong>,<em>,<a>,<br>,<ul>,<li>

RESPONSE FORMAT — reply with ONLY valid JSON (no markdown fences):
{
  "reply": "natural spoken answer — human, thoughtful, discuss/explain; easy for TTS",
  "action": one of none | email | sequence | analysis | navigate | ui_action
}

ui_action shape:
{ "type": "ui_action", "name": "<from list above>", "label": "Button label",
  "confirm": true|false, "params": { "listId": "...", "sequenceId": "...", "query": "..." } }

When page / entity IDs are in context, use them.
"take me to X" → navigate. "enroll this list" → ui_action enroll_list with confirm true.`;


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
  if (r.type === "navigate") {
    const path = typeof r.path === "string" ? r.path.trim() : "";
    if (!path.startsWith("/")) return { type: "none" };
    // Only allow in-app relative paths (block protocol / //).
    if (path.includes("://") || path.startsWith("//")) return { type: "none" };
    const label =
      typeof r.label === "string" && r.label.trim()
        ? r.label.trim().slice(0, 80)
        : `Open ${path}`;
    return { type: "navigate", path: path.slice(0, 200), label };
  }
  if (r.type === "ui_action") {
    const nameRaw = typeof r.name === "string" ? r.name.trim() : "";
    if (!UI_ACTION_NAMES.includes(nameRaw as UiActionName)) return { type: "none" };
    const name = nameRaw as UiActionName;
    const label =
      typeof r.label === "string" && r.label.trim()
        ? r.label.trim().slice(0, 80)
        : name.replace(/_/g, " ");
    const params: Record<string, string> = {};
    if (r.params && typeof r.params === "object" && !Array.isArray(r.params)) {
      for (const [k, v] of Object.entries(r.params as Record<string, unknown>)) {
        if (typeof v === "string" && v.trim() && k.length <= 40) {
          params[k.slice(0, 40)] = v.trim().slice(0, 200);
        }
      }
    }
    const confirm =
      typeof r.confirm === "boolean"
        ? r.confirm
        : name === "enroll_list";
    return {
      type: "ui_action",
      name,
      label,
      ...(Object.keys(params).length ? { params } : {}),
      confirm,
    };
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
      log.error("ai.service: OpenAI call failed", err);
      captureException(err, { module: "ai.service", op: "generateEmail" });
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
        prospectId?: string;
        threadId?: string;
        listId?: string;
        sequenceId?: string;
      };
      insights?: string | null;
      workspaceFacts?: string | null;
      appGuides?: string | null;
      /** Optional read-only workspace tools the model may call to fetch live data on demand. */
      toolRunner?: WorkspaceToolRunner | null;
      /** "dexter" = voice-first agent persona with ui_action emphasis. "cro" = admin-only exec rollup (R19.2). */
      agent?: "skout" | "dexter" | "cro";
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
    if (input.context?.prospectId)
      contextLines.push(`Focused prospectId: ${input.context.prospectId} (use get_prospect if needed).`);
    if (input.context?.threadId)
      contextLines.push(`Focused threadId: ${input.context.threadId} (use get_thread if needed).`);
    if (input.context?.listId)
      contextLines.push(`Focused listId: ${input.context.listId} (use get_list_detail if needed).`);
    if (input.context?.sequenceId)
      contextLines.push(
        `Focused sequenceId: ${input.context.sequenceId} (use get_sequence / get_sequence_analytics).`
      );
    if (input.context?.subject) contextLines.push(`Current subject: ${input.context.subject}`);
    if (input.context?.body) contextLines.push(`Current body:\n${input.context.body}`);
    if (input.workspaceFacts?.trim()) {
      contextLines.push(
        `Workspace facts (quick snapshot — prefer tools for specifics):\n${input.workspaceFacts.trim()}`
      );
    }
    if (input.appGuides?.trim()) {
      contextLines.push(`Product guides (how Skout works):\n${input.appGuides.trim()}`);
    }
    if (input.insights?.trim()) contextLines.push(`What works for this workspace:\n${input.insights.trim()}`);

    const systemPrompt =
      input.agent === "dexter" ? DEXTER_SYSTEM_PROMPT : input.agent === "cro" ? CRO_SYSTEM_PROMPT : CHAT_SYSTEM_PROMPT;

    const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
      { role: "system", content: systemPrompt },
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
    let toolsEnabled = Boolean(toolRunner);

    const formatChatErr = (err: unknown): string => {
      if (err instanceof Error) {
        const anyErr = err as Error & { status?: number; error?: unknown; code?: string };
        const detail =
          anyErr.error != null
            ? typeof anyErr.error === "string"
              ? anyErr.error
              : JSON.stringify(anyErr.error)
            : "";
        return [anyErr.message, anyErr.status ? `status=${anyErr.status}` : "", detail]
          .filter(Boolean)
          .join(" | ");
      }
      try {
        return JSON.stringify(err);
      } catch {
        return String(err);
      }
    };

    try {
      for (let round = 0; ; round += 1) {
        // Tool rounds must NOT force json_object — providers reject / confuse tool_calls with
        // JSON mode. Only lock JSON on the final answer turn (no tools / after max rounds).
        const allowTools = toolsEnabled && round < MAX_TOOL_ROUNDS;
        let result;
        try {
          result = await client.chat.completions.create({
            model,
            max_tokens: 3500,
            temperature: 0.55,
            messages,
            ...(allowTools
              ? { tools: toolRunner!.tools, tool_choice: "auto" as const }
              : { response_format: { type: "json_object" as const } }),
          });
        } catch (toolErr) {
          // If OpenRouter/provider rejects the tool schema, fall back to plain JSON chat once.
          if (allowTools && round === 0) {
            log.warn("ai.service: tools rejected — retrying without tools", {
              err: formatChatErr(toolErr),
            });
            toolsEnabled = false;
            continue;
          }
          throw toolErr;
        }

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
      const msg = formatChatErr(err);
      log.error("ai.service: chat failed", err);
      captureException(err, { module: "ai.service", op: "chat" });
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
      log.error("ai.service: sequence generation failed", err);
      captureException(err, { module: "ai.service", op: "generateSequence" });
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
