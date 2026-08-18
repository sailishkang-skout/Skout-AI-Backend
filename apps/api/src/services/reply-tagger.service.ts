import OpenAI from "openai";
import { createLogger } from "@skout/observability";

const log = createLogger("reply-tagger.service");

export type ReplyTag =
  | "positive"
  | "negative"
  | "neutral"
  | "question"
  | "meeting_request"
  | "unsubscribe"
  | "other";

const VALID_TAGS = new Set<ReplyTag>([
  "positive",
  "negative",
  "neutral",
  "question",
  "meeting_request",
  "unsubscribe",
  "other",
]);

/** Only meaningful when tag === "negative" — see condition-engine spec §11. */
export type NegativeSubtype =
  | "not_interested"
  | "do_not_contact"
  | "wrong_person"
  | "competitor"
  | "timing"
  | "already_customer"
  | "other";

const VALID_NEGATIVE_SUBTYPES = new Set<NegativeSubtype>([
  "not_interested",
  "do_not_contact",
  "wrong_person",
  "competitor",
  "timing",
  "already_customer",
  "other",
]);

/**
 * Three-tier confidence policy (condition-engine spec §14/§41):
 *   >= AUTO_CONFIDENCE_THRESHOLD        → auto-apply silently.
 *   MANUAL_REVIEW..AUTO (exclusive)     → "cautious": still auto-apply (spec says
 *                                         "configurable / cautious branch", not "block"), but
 *                                         raise a non-blocking FYI notification so a human can
 *                                         double-check after the fact rather than before.
 *   < MANUAL_REVIEW_CONFIDENCE_THRESHOLD → route to MANUAL_REVIEW: skip the automatic branch
 *                                         entirely and notify before anything is decided.
 */
export const MANUAL_REVIEW_CONFIDENCE_THRESHOLD = 0.6;
export const AUTO_CONFIDENCE_THRESHOLD = 0.85;

export type ConfidenceTier = "auto" | "cautious" | "manual_review";

export function classifyConfidenceTier(confidence: number): ConfidenceTier {
  if (confidence >= AUTO_CONFIDENCE_THRESHOLD) return "auto";
  if (confidence >= MANUAL_REVIEW_CONFIDENCE_THRESHOLD) return "cautious";
  return "manual_review";
}

export interface ReplyClassification {
  tag: ReplyTag;
  /** 0–1. */
  confidence: number;
  /** Short human-readable justification, surfaced in the manual-review notification. */
  reason: string;
  negativeSubtype?: NegativeSubtype;
}

/**
 * Tag an inbound human reply with intent/sentiment/confidence via OpenRouter.
 * Returns null when OPENROUTER_API_KEY is absent or the call fails (caller logs + skips).
 */
export async function tagReply(
  bodyText: string,
  apiKey: string | undefined
): Promise<ReplyClassification | null> {
  if (!apiKey) return null;

  const client = new OpenAI({
    apiKey,
    baseURL: "https://openrouter.ai/api/v1",
    defaultHeaders: { "HTTP-Referer": "https://skoutai.io", "X-Title": "Skout AI" },
  });

  let result: OpenAI.Chat.ChatCompletion;
  try {
    result = await client.chat.completions.create({
      model: process.env.AI_MODEL ?? "openai/gpt-4o-mini",
      max_tokens: 150,
      messages: [
        {
          role: "system",
          content:
            "Classify the sentiment and intent of the email reply below, for a sales outreach sequence engine.\n\n" +
            "Respond with ONLY strict JSON, no markdown fences, no explanation outside the JSON:\n" +
            '{"tag": "positive" | "negative" | "neutral" | "question" | "meeting_request" | "unsubscribe" | "other", ' +
            '"confidence": number between 0 and 1, ' +
            '"reason": "one short sentence justifying the tag", ' +
            '"negative_subtype": "not_interested" | "do_not_contact" | "wrong_person" | "competitor" | "timing" | "already_customer" | "other" | null}\n\n' +
            'negative_subtype is only meaningful when tag is "negative" — use null otherwise. ' +
            'Use "do_not_contact" specifically when the reply asks to stop being contacted / be removed / not to be emailed again — ' +
            "that subtype triggers an automatic opt-out, so only use it when the prospect is actually asking to stop hearing from us, " +
            'not for a plain "not interested".',
        },
        { role: "user", content: bodyText.slice(0, 2000) },
      ],
    });
  } catch (err) {
    log.warn("reply-tagger: OpenRouter API call failed", { err });
    return null;
  }

  const raw = result.choices[0]?.message?.content;
  if (!raw) return null;

  let parsed: {
    tag?: unknown;
    confidence?: unknown;
    reason?: unknown;
    negative_subtype?: unknown;
  };
  try {
    parsed = JSON.parse(raw);
  } catch {
    log.warn("reply-tagger: unexpected non-JSON response", { raw });
    return null;
  }

  const tag = typeof parsed.tag === "string" ? (parsed.tag.trim().toLowerCase() as ReplyTag) : undefined;
  if (!tag || !VALID_TAGS.has(tag)) {
    log.warn("reply-tagger: unexpected tag from model", { raw });
    return null;
  }

  const confidence =
    typeof parsed.confidence === "number" && Number.isFinite(parsed.confidence)
      ? Math.max(0, Math.min(1, parsed.confidence))
      : 0.5; // model omitted it — treat as uncertain rather than crashing or auto-applying

  const reason = typeof parsed.reason === "string" ? parsed.reason.slice(0, 500) : "";

  const rawSubtype =
    typeof parsed.negative_subtype === "string" ? parsed.negative_subtype.trim().toLowerCase() : undefined;
  const negativeSubtype =
    tag === "negative" && rawSubtype && VALID_NEGATIVE_SUBTYPES.has(rawSubtype as NegativeSubtype)
      ? (rawSubtype as NegativeSubtype)
      : undefined;

  return { tag, confidence, reason, negativeSubtype };
}

export interface OooReturnDateResult {
  /** ISO 8601 date (YYYY-MM-DD), or null when no return date is stated in the auto-reply. */
  returnDate: string | null;
}

/**
 * Condition-engine spec §12's optional `ooo_until` — extract a stated return date from an
 * out-of-office auto-reply body ("back on Monday the 14th", "returning August 3rd", etc).
 * Returns null (not a low-confidence guess) whenever the model can't find an explicit date, so
 * the caller can safely fall back to the fixed default wait window.
 */
export async function extractOooReturnDate(
  bodyText: string,
  apiKey: string | undefined,
  referenceDate: Date
): Promise<OooReturnDateResult | null> {
  if (!apiKey) return null;

  const client = new OpenAI({
    apiKey,
    baseURL: "https://openrouter.ai/api/v1",
    defaultHeaders: { "HTTP-Referer": "https://skoutai.io", "X-Title": "Skout AI" },
  });

  let result: OpenAI.Chat.ChatCompletion;
  try {
    result = await client.chat.completions.create({
      model: process.env.AI_MODEL ?? "openai/gpt-4o-mini",
      max_tokens: 60,
      messages: [
        {
          role: "system",
          content:
            `Today's date is ${referenceDate.toISOString().slice(0, 10)}. This is an out-of-office ` +
            "auto-reply email. Does it state a specific date the person returns to the office? " +
            'Respond with ONLY strict JSON: {"return_date": "YYYY-MM-DD" | null} — ' +
            "return_date is the resolved absolute date (resolve relative phrases like \"back Monday\" " +
            "or \"returning next week\" against today's date above), or null if no date is stated at all.",
        },
        { role: "user", content: bodyText.slice(0, 2000) },
      ],
    });
  } catch (err) {
    log.warn("reply-tagger: OOO return-date extraction call failed", { err });
    return null;
  }

  const raw = result.choices[0]?.message?.content;
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw) as { return_date?: unknown };
    const returnDate =
      typeof parsed.return_date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(parsed.return_date)
        ? parsed.return_date
        : null;
    return { returnDate };
  } catch {
    log.warn("reply-tagger: unexpected non-JSON OOO return-date response", { raw });
    return null;
  }
}

export interface BudgetFreezeDetection {
  detected: boolean;
  /** Short quote from the reply that triggered the detection — used as the plain-language reason. */
  snippet?: string;
}

/**
 * R18.2 — detect budget-freeze / spending-pause language in an inbound reply, independent of
 * the reply's overall sentiment tag (a "we love it but budget's frozen" reply reads neutral or
 * even positive on tagReply, but is still a distinct deal-risk signal).
 */
export async function detectBudgetFreeze(
  bodyText: string,
  apiKey: string | undefined
): Promise<BudgetFreezeDetection | null> {
  if (!apiKey) return null;

  const client = new OpenAI({
    apiKey,
    baseURL: "https://openrouter.ai/api/v1",
    defaultHeaders: { "HTTP-Referer": "https://skoutai.io", "X-Title": "Skout AI" },
  });

  let result: OpenAI.Chat.ChatCompletion;
  try {
    result = await client.chat.completions.create({
      model: process.env.AI_MODEL ?? "openai/gpt-4o-mini",
      max_tokens: 60,
      messages: [
        {
          role: "system",
          content:
            "Does this email reply mention a budget freeze, spending pause, hiring freeze affecting purchases, " +
            "or that funding/budget for this purchase has been cut or delayed? " +
            'Respond with ONLY strict JSON: {"detected": boolean, "snippet": string | null} — ' +
            "snippet is the short quoted phrase that triggered a true detection, or null.",
        },
        { role: "user", content: bodyText.slice(0, 2000) },
      ],
    });
  } catch (err) {
    log.warn("reply-tagger: budget-freeze detection call failed", { err });
    return null;
  }

  const raw = result.choices[0]?.message?.content;
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw) as { detected?: unknown; snippet?: unknown };
    if (typeof parsed.detected !== "boolean") return null;
    return {
      detected: parsed.detected,
      snippet: typeof parsed.snippet === "string" ? parsed.snippet : undefined,
    };
  } catch {
    log.warn("reply-tagger: unexpected non-JSON budget-freeze response", { raw });
    return null;
  }
}
