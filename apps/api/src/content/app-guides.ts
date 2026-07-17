/**
 * Compact product knowledge for the AI chat assistant.
 * Keep short — injected into the model prompt (not a full RAG corpus).
 */

export interface AppGuideSnippet {
  slug: string;
  title: string;
  href: string;
  keywords: string[];
  body: string;
}

export const APP_GUIDE_SNIPPETS: AppGuideSnippet[] = [
  {
    slug: "workspace",
    title: "Workspace & credits",
    href: "/settings/workspace",
    keywords: ["workspace", "credits", "rename", "billing", "balance", "top up", "top-up"],
    body: `Rename the workspace and view credit balance under Settings → Workspace.
Credits are spent on enrichment, scoring, search, and some exports.
Buy packs via Razorpay on the same page; paid orders appear as downloadable invoices.`,
  },
  {
    slug: "import-prospects",
    title: "Import prospects",
    href: "/import",
    keywords: ["import", "csv", "excel", "xlsx", "pdf", "ocr", "upload", "prospect"],
    body: `Open Import (/import). Upload CSV, Excel, PDF, or PNG/JPEG (OCR).
SVG is parsed as text (not OCR). Preview rows, pick or create a list, then commit.
Sample files live in the backend docs/samples/import folder for testing.`,
  },
  {
    slug: "lists-enrich",
    title: "Lists, enrich & enroll",
    href: "/lists",
    keywords: ["list", "enrich", "enroll", "verify", "member", "score"],
    body: `Create lists under Lists. Add prospects from search, import, or enrichment.
Enrich members to find email/phone; verify emails before outreach.
Enroll a list into a sequence from the list detail page.`,
  },
  {
    slug: "sequences-ai",
    title: "Sequences & AI Auto/Ask",
    href: "/sequences",
    keywords: ["sequence", "cadence", "auto", "ask", "step", "linkedin", "email step"],
    body: `Build multi-step cadences (email, LinkedIn, wait) under Sequences.
AI chat Ask mode proposes copy/sequences for you to confirm.
Auto mode applies email to the editor or creates the sequence immediately.
Email drafts can be segregated into AI Review before send.`,
  },
  {
    slug: "ai-review",
    title: "AI Review",
    href: "/ai/review",
    keywords: ["review", "approve", "draft", "sent", "outbox", "reject"],
    body: `AI Review queues AI-written emails. Approve & send delivers to the prospect,
marks the draft Sent, and shows the thread under Inbox → Sent.
Reject discards; Edit moves drafts to Edited for another look.`,
  },
  {
    slug: "connect-inbox",
    title: "Connect inbox",
    href: "/deliverability",
    keywords: ["inbox", "smtp", "imap", "send", "mailbox", "connect"],
    body: `Connect a sending inbox under Deliverability → Inboxes with SMTP/IMAP.
Run a test send. Sequences and AI Review approve-send need an active inbox.`,
  },
  {
    slug: "sending-domain",
    title: "Sending domain",
    href: "/deliverability",
    keywords: ["domain", "spf", "dkim", "dmarc", "dns", "mx"],
    body: `Add a sending domain under Deliverability → Domains.
Publish SPF, DKIM, DMARC (and MX if required), then verify DNS in-app.`,
  },
  {
    slug: "deliverability",
    title: "Deliverability",
    href: "/deliverability",
    keywords: ["deliverability", "bounce", "spam", "warmup", "health", "reputation"],
    body: `Deliverability shows inbox health, bounce/spam signals, warmup, and analytics.
Keep volumes gradual and suppress unsubscribes/bounces.`,
  },
  {
    slug: "integrations",
    title: "Integrations",
    href: "/settings/integrations",
    keywords: ["integration", "hunter", "apollo", "byok", "api key", "provider"],
    body: `Add enrichment provider API keys under Settings → Integrations (BYOK).
Workspace keys are preferred before platform defaults.
For HubSpot CRM connect/import/export, use Settings → CRM (/settings/crm) instead.`,
  },
  {
    slug: "hubspot-crm",
    title: "Connect HubSpot CRM",
    href: "/settings/crm",
    keywords: [
      "hubspot",
      "hub spot",
      "crm",
      "connect hubspot",
      "import from hubspot",
      "export to hubspot",
      "oauth",
    ],
    body: `How to connect HubSpot:
1. Open Settings → CRM (/settings/crm).
2. Click "Connect HubSpot". You are redirected to HubSpot OAuth — approve the app.
3. After redirect back, status shows Connected (portal id visible).
4. Import: choose All contacts or a HubSpot list, pick/create a Skout list, then Import (free, up to 500 contacts per run).
5. Export: from a Skout list, push enriched contacts to HubSpot (1 credit per contact).
6. Disconnect anytime on the same page.

Requirements: server must have HUBSPOT_CLIENT_ID and HUBSPOT_CLIENT_SECRET configured.
If Connect fails with "not configured", ask an admin to add those secrets.
Open HubSpot contacts: https://app.hubspot.com/contacts`,
  },
  {
    slug: "billing-invoices",
    title: "Billing & invoices",
    href: "/settings/workspace",
    keywords: ["invoice", "razorpay", "pack", "payment", "receipt"],
    body: `Buy credit packs with Razorpay on Workspace settings.
Paid orders appear as monthly invoices you can download as HTML.`,
  },
  {
    slug: "search-icp",
    title: "Search & ICP",
    href: "/search",
    keywords: ["search", "icp", "ideal", "filter", "corpus"],
    body: `Configure ICP under Settings / ICP so scoring and search match your buyer profile.
Use Search to find companies/prospects from the corpus, then activate into lists.`,
  },
  {
    slug: "inbox",
    title: "Inbox & Sent",
    href: "/inbox",
    keywords: ["inbox", "reply", "thread", "sent", "outbox", "folder"],
    body: `Inbox shows conversations. Use folder Sent for outbound / Outbox messages.
Approve AI drafts to send and see them under Inbox → Sent.`,
  },
];

/** Pick the most relevant guide snippets for the latest user message + page. */
export function selectAppGuides(opts: {
  userMessage?: string;
  page?: string;
  limit?: number;
}): AppGuideSnippet[] {
  const limit = opts.limit ?? 4;
  const hay = `${opts.userMessage ?? ""} ${opts.page ?? ""}`.toLowerCase();
  const scored = APP_GUIDE_SNIPPETS.map((g) => {
    let score = 0;
    for (const kw of g.keywords) {
      if (hay.includes(kw.toLowerCase())) score += 2;
    }
    if (opts.page) {
      if (opts.page.includes(g.href) || opts.page.includes(g.slug)) score += 3;
    }
    return { g, score };
  });
  scored.sort((a, b) => b.score - a.score);
  const picked = scored.filter((s) => s.score > 0).slice(0, limit).map((s) => s.g);
  if (picked.length >= 2) return picked;
  // Always give a small baseline set so the model knows core product paths.
  return APP_GUIDE_SNIPPETS.slice(0, Math.min(limit, 4));
}

export function appGuidesToPrompt(guides: AppGuideSnippet[]): string {
  if (!guides.length) return "";
  return guides
    .map((g) => `### ${g.title} (${g.href})\n${g.body}`)
    .join("\n\n");
}
