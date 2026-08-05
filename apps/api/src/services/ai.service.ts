/**
 * AI orchestration — Dexter / Skout chat.
 *
 * MVP rule-based stub. The real agent (LiteLLM + PAL) will replace `chat()`,
 * but the response contract below is stable and matches the frontend's
 * `ChatResponse` type in `src/lib/ai-chat.ts`.
 */

export type ChatMode = "auto" | "ask";
export type ChatAgent = "skout" | "dexter";

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export interface ChatContext {
  page?: string;
  subject?: string;
  body?: string;
  kind?: string;
  prospectId?: string;
  threadId?: string;
  listId?: string;
  sequenceId?: string;
}

export interface ChatAction {
  type: "none" | "navigate" | "ui_action";
  path?: string;
  label?: string;
  name?: string;
  params?: Record<string, string>;
  confirm?: boolean;
}

export interface ChatResponse {
  reply: string;
  action: ChatAction;
  applied: boolean;
  mode?: ChatMode;
  agent?: ChatAgent;
  segregated?: boolean;
}

interface Intent {
  action: ChatAction;
  reply: string;
}

const NAVIGATION_INTENTS: Array<{ re: RegExp; label: string; path: string }> = [
  { re: /(go|take me|open|navigate|bring me).*inbox/i, label: "Open Inbox", path: "/inbox" },
  { re: /(go|take me|open|navigate|bring me).*sequences/i, label: "Open Sequences", path: "/sequences" },
  { re: /(go|take me|open|navigate|bring me).*lists/i, label: "Open Smart Lists", path: "/lists" },
  { re: /(ai review|review)/i, label: "Open AI Review", path: "/ai/review" },
  { re: /(go|take me|open|navigate).*analytics/i, label: "Open Analytics", path: "/analytics" },
  { re: /(deliverability)/i, label: "Open Deliverability", path: "/deliverability" },
  {
    re: /(settings)/i,
    label: "Open Settings",
    path: "/settings",
  },
];

const SEARCH_INTENT =
  /(find|search|look for|show me).*(vp|director|head|manager|title|prospect|lead|company)/i;

export class AiService {
  async listDrafts(workspaceId: string) {
    return { workspaceId, data: [], total: 0 };
  }

  /** Rule-based Dexter/Skout chat. Returns a stable ChatResponse contract. */
  async chat(input: {
    messages: ChatMessage[];
    mode?: ChatMode;
    agent?: ChatAgent;
    context?: ChatContext;
  }): Promise<ChatResponse> {
    const messages = input.messages ?? [];
    const lastUser = [...messages].reverse().find((m) => m.role === "user");
    const query = lastUser?.content?.trim() ?? "";
    const mode = input.mode ?? "ask";
    const agent = input.agent ?? "skout";

    const intent = this.resolveIntent(query);

    return {
      reply: intent.reply,
      action: intent.action,
      applied: intent.action.type === "navigate" || intent.action.type === "ui_action",
      mode,
      agent,
      segregated: false,
    };
  }

  private resolveIntent(query: string): Intent {
    const q = query.toLowerCase();

// Navigation intents — Dexter "acts" by navigating.
    for (const intent of NAVIGATION_INTENTS) {
      if (intent.re.test(query)) {
        if (intent.path === "/settings" && /integration|settings|billing|team/i.test(q)) {
          return {
            action: { type: "navigate", path: "/settings", label: "Open Settings" },
            reply: "Sure — taking you to Settings now.",
          };
        }
        return {
          action: { type: "navigate", path: intent.path, label: intent.label },
          reply: `On it — opening your ${intent.label.replace("Open ", "").toLowerCase()}.`,
        };
      }
    }

    // Search intent — routes to prospects search.
    if (SEARCH_INTENT.test(query)) {
      const title = query.match(/(vp|director|head|manager)/)?.[0] ?? "VP Sales";
      const industry = query.match(/saas|fintech|software|healthcare/i)?.[0] ?? "SaaS";
      return {
        action: {
          type: "navigate",
          path: `/prospects/search?q=${encodeURIComponent(`${title} ${industry}`)}`,
          label: "Search prospects",
        },
reply: `I can point you to that. Searching for ${title} in ${industry} — open the search page and the filters will be ready.`,
      };
    }

    // Credit usage / analytics-like questions.
    if (/(credit|usage|spend|analytics)/.test(q)) {
      return {
        action: { type: "navigate", path: "/analytics", label: "Open Analytics" },
        reply:
          "I don't have live credit numbers wired up yet, but I can take you to Analytics where the usage breakdown is shown.",
      };
    }

    // Unknown / fallback.
    return {
      action: { type: "none" },
      reply:
        "I'm still learning that one. Right now I can navigate you around Skout — for example, ask me to take you to your inbox, sequences, lists, AI Review, or Settings. What would you like to do?",
    };
  }
}

export const aiService = new AiService();
