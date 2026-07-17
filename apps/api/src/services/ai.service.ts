import OpenAI from "openai";
import { createLogger } from "@skout/observability";

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

export type ChatAction =
  | { type: "none" }
  | { type: "email"; subject: string; html: string }
  | { type: "sequence"; name: string; steps: GeneratedSequenceStep[] };

const CHAT_SYSTEM_PROMPT = `You are Skout's outbound copy assistant embedded in the app. You help
users write email templates and design multi-step sequences through conversation.

Merge tokens — use ONLY these in any subject/body:
  {{firstName}} {{fullName}} {{companyName}} {{title}} {{senderName}} {{unsubscribeUrl}}
Never invent names/companies or use square-bracket placeholders like [Your Name].

Always reply with ONLY a valid JSON object (no markdown, no code fences):
  "reply": a short conversational message to the user (what you did / a question / a suggestion)
  "action": one of:
    { "type": "none" }  — when just chatting, clarifying, or answering a question
    { "type": "email", "subject": "...", "html": "..." }  — when the user wants an email/template.
       html uses only <p>,<strong>,<em>,<a>,<br>,<ul>,<li>; greeting "Hi {{firstName}},";
       sign off {{senderName}}; end with the unsubscribe paragraph:
       <p style="font-size:11px;color:#888"><a href="{{unsubscribeUrl}}">Unsubscribe</a></p>
    { "type": "sequence", "name": "...", "steps": [ ... ] }  — when the user wants a cadence.
       Each step: { "stepType": "email"|"linkedin"|"wait", "delayDays": int>=0, "delayUnit": "days",
       "linkedinAction": "connect"|"message" (linkedin only),
       "subject": "..." (email only), "bodyTemplate": "..." (email HTML / linkedin plain text) }.
       4–6 steps, first delayDays 0, later steps 2–4 days apart.

If the user asks to tweak the current subject/body provided in context, return an "email" action
with the full revised version. Keep copy concise and deliverability-safe.`;

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
  return { type: "none" };
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
      context?: { subject?: string; body?: string; kind?: "email" | "sequence" | "general" };
      insights?: string | null;
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
    if (input.context?.subject) contextLines.push(`Current subject: ${input.context.subject}`);
    if (input.context?.body) contextLines.push(`Current body:\n${input.context.body}`);
    if (input.insights?.trim()) contextLines.push(`What works for this workspace:\n${input.insights.trim()}`);

    const messages = [
      { role: "system" as const, content: CHAT_SYSTEM_PROMPT },
      ...(contextLines.length
        ? [{ role: "system" as const, content: contextLines.join("\n") }]
        : []),
      ...input.messages.map((m) => ({ role: m.role, content: m.content })),
    ];

    let raw: string;
    try {
      const result = await client.chat.completions.create({
        model: process.env.AI_MODEL ?? "openai/gpt-4o-mini",
        max_tokens: 2500,
        temperature: 0.6,
        response_format: { type: "json_object" },
        messages,
      });
      raw = result.choices[0]?.message?.content ?? "{}";
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
