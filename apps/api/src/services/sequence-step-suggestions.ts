/**
 * Context-aware AI suggestions for a single sequence step (Email / LinkedIn).
 *
 * Pure prompt-building and output-sanitising logic, kept free of DB and LLM imports so it is
 * unit-testable. `AiService.suggestStepContent` does the model call; `sequence-step-suggest.service`
 * gathers the sequence context.
 */
import { MERGE_TOKENS } from "./sequence-merge-tokens.js";

export type SuggestableLinkedinAction = "connect" | "message" | "inmail";

export interface StepSuggestionTarget {
  stepType: "email" | "linkedin";
  /** Required when stepType is "linkedin". */
  linkedinAction?: SuggestableLinkedinAction;
}

export interface StepSuggestion {
  /** Short label for the approach, e.g. "Warm intro". */
  angle: string;
  /** Present for email only — LinkedIn steps have no subject. */
  subject?: string;
  /** HTML for email; plain text for LinkedIn. */
  body: string;
}

export interface SiblingStepInput {
  stepOrder: number;
  stepType: string;
  linkedinAction?: string | null;
  delayDays: number;
  delayUnit?: string | null;
  subject: string | null;
  bodyTemplate: string | null;
}

export interface StepSuggestionContext {
  sequenceName: string;
  target: StepSuggestionTarget;
  /** 1-based position of the step being written. */
  position: number;
  total: number;
  /** Pre-rendered summaries (see summarizeSiblingStep) of the steps before / after this one. */
  before: string[];
  after: string[];
  audience?: string | null;
  insights?: string | null;
  /** Angles already shown to the user — asks the model for something different. */
  excludeAngles?: string[];
}

export const MAX_SUGGESTIONS = 3;
const SUBJECT_MAX = 80;
const SNIPPET_MAX = 160;
const BODY_MAX: Record<SuggestableLinkedinAction, number> = {
  connect: 300,
  message: 700,
  inmail: 1200,
};

const UNSUBSCRIBE_FOOTER =
  '<p style="font-size:11px;color:#888"><a href="{{unsubscribeUrl}}">Unsubscribe</a></p>';

const LINKEDIN_BODY_ONLY =
  'LinkedIn steps have no subject — omit the "subject" field. No HTML, no unsubscribe link.';

function stripTags(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>\s*<p[^>]*>/gi, "\n\n")
    .replace(/<[^>]+>/g, "")
    .trim();
}

function snippet(html: string | null, max = SNIPPET_MAX): string {
  return (html ?? "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

/** One-line description of a neighbouring step, for the prompt. */
export function summarizeSiblingStep(step: SiblingStepInput): string {
  const head = `Step ${step.stepOrder} · ${step.stepType}`;
  const unit = step.delayUnit ?? "days";
  switch (step.stepType) {
    case "wait":
      return `${head} ${step.delayDays} ${unit}`;
    case "email": {
      const parts = [`${head} (+${step.delayDays} ${unit})`];
      if (step.subject?.trim()) parts.push(`subject "${step.subject.trim()}"`);
      const body = snippet(step.bodyTemplate);
      if (body) parts.push(`— ${body}`);
      return parts.join(" ");
    }
    case "linkedin": {
      const parts = [`${head}${step.linkedinAction ? ` (${step.linkedinAction})` : ""}`];
      const body = snippet(step.bodyTemplate);
      if (body) parts.push(`— ${body}`);
      return parts.join(" ");
    }
    default:
      return head;
  }
}

function channelRules(target: StepSuggestionTarget): string {
  if (target.stepType === "email") {
    return [
      "Channel: email.",
      `"subject": plain-text subject line, max ${SUBJECT_MAX} characters (tokens allowed).`,
      '"body": HTML using only <p>, <strong>, <em>, <a>, <br>, <ul>, <li> — 3 to 5 short paragraphs, no wrapper tags.',
      'Greet with "Hi {{firstName}}," and sign off with {{senderName}}.',
      `End the body with exactly: ${UNSUBSCRIBE_FOOTER}`,
    ].join("\n");
  }
  switch (target.linkedinAction) {
    case "connect":
      return [
        "Channel: LinkedIn connection request note.",
        `"body": plain text, under 250 characters (hard limit ${BODY_MAX.connect}). A specific, friendly reason to connect — no pitch.`,
        LINKEDIN_BODY_ONLY,
      ].join("\n");
    case "inmail":
      return [
        "Channel: LinkedIn InMail.",
        `"body": plain text, under 1000 characters, 2 short paragraphs, one clear call to action. ${LINKEDIN_BODY_ONLY}`,
      ].join("\n");
    default:
      return [
        "Channel: LinkedIn direct message to an existing connection.",
        `"body": plain text, 2 to 4 short sentences (max 600 characters), conversational, one soft call to action. ${LINKEDIN_BODY_ONLY}`,
      ].join("\n");
  }
}

export function buildStepSuggestionPrompt(ctx: StepSuggestionContext): { system: string; user: string } {
  const tokens = [...MERGE_TOKENS].map((t) => `{{${t}}}`).join(" ");
  const system = [
    "You are an expert B2B outbound copywriter helping a sales rep fill in ONE step of a multi-step sequence.",
    `Write ${MAX_SUGGESTIONS} distinct drafts for that step, each taking a genuinely different angle.`,
    "The drafts must fit the sequence's topic, follow on from earlier steps without repeating them, and leave room for later steps.",
    "",
    `Merge tokens — use ONLY these exact placeholders: ${tokens}`,
    "Never invent names, companies, products or metrics. Never write square-bracket placeholders like [Your Name] — use a merge token instead.",
    "Keep copy concise and deliverability-safe (avoid spam-trigger words).",
    "",
    channelRules(ctx.target),
    "",
    `Return ONLY a valid JSON object (no markdown, no code fences): ${
      ctx.target.stepType === "email"
        ? '{"suggestions":[{"angle":"2-4 word label","subject":"…","body":"…"}]}'
        : '{"suggestions":[{"angle":"2-4 word label","body":"…"}]}'
    }`,
  ].join("\n");

  const lines: (string | null)[] = [
    `Sequence: "${ctx.sequenceName.trim()}"`,
    `This is step ${ctx.position} of ${ctx.total}.`,
    ctx.before.length
      ? `Steps before this one:\n${ctx.before.join("\n")}`
      : "There are no steps before this one — this is the opening touch.",
    ctx.after.length ? `Steps after this one:\n${ctx.after.join("\n")}` : null,
    ctx.audience?.trim() ? `Audience:\n${ctx.audience.trim()}` : null,
    ctx.insights?.trim() ? `What has worked for this workspace:\n${ctx.insights.trim()}` : null,
    ctx.excludeAngles?.length
      ? `Already suggested — avoid these angles: ${ctx.excludeAngles.join("; ")}`
      : null,
    `Write ${MAX_SUGGESTIONS} drafts for step ${ctx.position}.`,
  ];
  return { system, user: lines.filter(Boolean).join("\n\n") };
}

/** True when text uses a merge token the API would reject, or a bracketed placeholder. */
function hasInvalidPlaceholder(text: string): boolean {
  for (const m of text.matchAll(/\{\{([^}]*)\}\}/g)) {
    if (!MERGE_TOKENS.has(m[1]!)) return true;
  }
  return /\[[^\]\n]{1,40}\]/.test(text);
}

function escapeText(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function toEmailHtml(body: string): string {
  const html = /<\s*(p|ul|ol|div|br)\b/i.test(body)
    ? body.trim()
    : body
        .split(/\n{2,}/)
        .map((para) => para.trim())
        .filter(Boolean)
        .map((para) => `<p>${escapeText(para).replace(/\n/g, "<br>")}</p>`)
        .join("");
  return html.includes("{{unsubscribeUrl}}") ? html : `${html}${UNSUBSCRIBE_FOOTER}`;
}

/**
 * Parses the model's JSON and keeps only drafts that are safe to drop straight into a step:
 * valid merge tokens, required fields present, channel length limits respected. Never throws —
 * an unusable response yields [] and the caller decides how to surface that.
 */
export function coerceStepSuggestions(raw: string, target: StepSuggestionTarget): StepSuggestion[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  const list = (parsed as { suggestions?: unknown } | null)?.suggestions;
  if (!Array.isArray(list)) return [];

  const needsSubject = target.stepType === "email";
  const out: StepSuggestion[] = [];

  list.forEach((item, idx) => {
    if (out.length >= MAX_SUGGESTIONS || !item || typeof item !== "object") return;
    const r = item as Record<string, unknown>;

    const rawBody = typeof r.body === "string" ? r.body.trim() : "";
    if (!rawBody) return;
    const subject = typeof r.subject === "string" ? r.subject.trim().slice(0, SUBJECT_MAX) : "";
    if (needsSubject && !subject) return;

    const plainBody = target.stepType === "email" ? rawBody : stripTags(rawBody);
    if (target.stepType === "linkedin" && plainBody.length > BODY_MAX[target.linkedinAction ?? "message"]) return;
    if (hasInvalidPlaceholder(`${needsSubject ? subject : ""}\n${plainBody}`)) return;

    const angle =
      typeof r.angle === "string" && r.angle.trim() ? r.angle.trim().slice(0, 60) : `Option ${idx + 1}`;

    out.push({
      angle,
      ...(needsSubject ? { subject } : {}),
      body: target.stepType === "email" ? toEmailHtml(rawBody) : plainBody,
    });
  });

  return out;
}
