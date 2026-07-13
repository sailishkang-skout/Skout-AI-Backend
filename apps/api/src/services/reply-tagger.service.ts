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

/**
 * Tag an inbound human reply with intent/sentiment via OpenRouter.
 * Returns null when OPENROUTER_API_KEY is absent or the call fails (caller logs + skips).
 */
export async function tagReply(
  bodyText: string,
  apiKey: string | undefined
): Promise<ReplyTag | null> {
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
      max_tokens: 10,
      messages: [
        {
          role: "system",
          content:
            "Classify the sentiment and intent of the email reply below. " +
            "Respond with ONLY one of these labels (no explanation, no punctuation): " +
            "positive, negative, neutral, question, meeting_request, unsubscribe, other.",
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

  const tag = raw.trim().toLowerCase() as ReplyTag;
  if (!VALID_TAGS.has(tag)) {
    log.warn("reply-tagger: unexpected label from model", { raw });
    return null;
  }

  return tag;
}
