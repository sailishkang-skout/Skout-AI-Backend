import OpenAI from "openai";
import { createLogger } from "@skout/observability";

const log = createLogger("ai.service");

const SYSTEM_PROMPT = `You are an expert B2B sales email copywriter.
Generate a professional cold outreach email template in HTML format.

Rules:
- Use these merge tokens where appropriate: {{firstName}}, {{lastName}}, {{companyName}}, {{title}}, {{unsubscribeUrl}}
- Return ONLY a valid JSON object (no markdown, no code fences) with exactly two keys:
    "subject": plain-text subject line, max 80 characters
    "html": the email body as HTML — no <html>, <head>, or <body> wrapper tags
- HTML must use only clean inline-friendly tags: <p>, <strong>, <em>, <a>, <br>, <ul>, <li>
- Keep the email concise: 3–5 short paragraphs
- Always end with an unsubscribe paragraph: <p style="font-size:11px;color:#888"><a href="{{unsubscribeUrl}}">Unsubscribe</a></p>
- Tone: professional, personable, not spammy`;

export class AiService {
  async listDrafts(workspaceId: string) {
    return { workspaceId, data: [], total: 0 };
  }

  async generateEmail(
    prompt: string,
    apiKey: string | undefined
  ): Promise<{ html: string; subject: string }> {
    if (!apiKey) {
      throw Object.assign(new Error("OpenAI API key is not configured on this workspace"), {
        statusCode: 503,
      });
    }

    const client = new OpenAI({ apiKey });

    let raw: string;
    try {
      const result = await client.chat.completions.create({
        model: "gpt-4o-mini",
        max_tokens: 1200,
        temperature: 0.7,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          {
            role: "user",
            content: `Generate a B2B cold outreach email for: ${prompt.trim()}`,
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
}

export const aiService = new AiService();
