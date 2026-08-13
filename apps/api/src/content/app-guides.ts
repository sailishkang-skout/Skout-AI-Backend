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
    keywords: ["list", "enrich", "enroll", "verify", "member", "score", "email intel"],
    body: `Create lists under Lists. Add prospects from search, import, smart lists, or enrichment.
Enrich members to find email/phone; Verify uses email-intel then SMTP before outreach.
Enroll a list into an active sequence (Enroll tab) or into a 50/50 A/B experiment.`,
  },
  {
    slug: "sequences-ai",
    title: "Sequences, A/B tests & Dexter",
    href: "/sequences",
    keywords: [
      "sequence",
      "cadence",
      "auto",
      "ask",
      "step",
      "linkedin",
      "email step",
      "dexter",
      "god mode",
      "a/b",
      "50/50",
      "experiment",
      "condition",
      "fallback",
      "version",
      "template",
    ],
    body: `Sequences (/sequences) — one engine, three starts:
1) Manually from scratch = God Mode (C) visual builder (email, LinkedIn, call, WhatsApp, condition, delay, goal).
2) Templates = Mode A email-first or Mode B LinkedIn-first.
3) Dexter AI = describe the goal; drafts a Mode C cadence.
Condition nodes: LinkedIn invite accepted/declined/timeout → Yes/No fallback. Compound AND/OR/NOT supported.
Activate publishes a version snapshot so in-flight enrollments don't pick up later edits. Publish version after live changes. Activity tab is the event ledger.
50/50 experiment: Sequences → A/B experiment. Assignment is sha256(experimentId:prospectId). Compare reply rates on the experiment page.
Ask vs Auto still applies for AI copy. Connect an inbox (and Unipile for LinkedIn) before live sends.`,
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
    keywords: ["integration", "hunter", "apollo", "byok", "api key", "provider", "unipile", "linkedin", "whatsapp"],
    body: `Add Unipile (LinkedIn/WhatsApp) and enrichment provider API keys under Settings → Integrations (BYOK).
Workspace keys are preferred before platform defaults.
After saving Unipile, connect accounts under Deliverability → LinkedIn / WhatsApp.
Email-intel (when configured) powers Verify + send eligibility.
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
    href: "/prospects/search",
    keywords: [
      "search",
      "icp",
      "ideal",
      "filter",
      "corpus",
      "prospect",
      "find leads",
      "find people",
      "title",
      "industry",
    ],
    body: `Configure ICP under Settings → ICP (/settings/icp) or the onboarding wizard (/onboarding/icp).
Collect industries, geo, seniority, company size, buyer titles/keywords, and your company/product pains.
Use Prospect search (/prospects/search) to find people/companies from the corpus, score against ICP,
then activate into lists. Search costs credits per page; the AI chat search_prospects tool is a free preview.`,
  },
  {
    slug: "smart-lists",
    title: "Smart lists",
    href: "/smart-lists",
    keywords: ["smart list", "smart-lists", "saved search", "activate"],
    body: `Smart lists save filter sets. Preview matches, then create an activation list for bulk enrich/enroll.
Open /smart-lists.`,
  },
  {
    slug: "analytics",
    title: "Analytics",
    href: "/analytics",
    keywords: ["analytics", "dashboard", "funnel", "usage", "report", "chart"],
    body: `Workspace analytics live at /analytics (credits, enrichment, list activity).
Ask the assistant for charts/exports of credit usage anytime.`,
  },
  {
    slug: "team",
    title: "Team",
    href: "/settings/team",
    keywords: ["team", "invite", "member", "role", "sso", "otp"],
    body: `Invite teammates under Settings → Team. Roles: owner/admin/member.
Pending invites can use OTP or SSO. Cap is 50 members per workspace.`,
  },
  {
    slug: "inbox",
    title: "Inbox, LinkedIn & WhatsApp",
    href: "/inbox",
    keywords: ["inbox", "reply", "thread", "sent", "outbox", "folder", "whatsapp", "linkedin chat"],
    body: `Inbox shows email (IMAP) plus LinkedIn/WhatsApp after Unipile accounts are connected under Deliverability.
Approve AI drafts to send; they appear under Inbox → Sent.`,
  },
  {
    slug: "calling",
    title: "Click-to-call",
    href: "/settings/calling",
    keywords: ["call", "calling", "dial", "twilio", "phone", "click to call"],
    body: `Settings → Calling: save your agent number (E.164). Twilio dials you first, then the prospect.
Sequence Call steps and CRM contacts use the same dialer. Twilio Suspended accounts fail dials until unsuspended.`,
  },
  {
    slug: "google-calendar",
    title: "Google Calendar & Meet",
    href: "/settings/calendar",
    keywords: ["calendar", "google", "meet", "meeting", "schedule", "invite"],
    body: `Settings → Google Calendar → Connect (OAuth). Then create meetings from CRM → Meetings/Calendar with a real Meet link.
Requires GOOGLE_CLIENT_ID/SECRET on the API.`,
  },
  {
    slug: "crm-hubspot",
    title: "CRM & HubSpot",
    href: "/crm",
    keywords: ["crm", "deal", "company", "contact", "pipeline", "task", "meeting"],
    body: `CRM Overview, Companies, Contacts, Deals, Tasks, Meetings live under /crm.
HubSpot import/export is Settings → CRM (/settings/crm).`,
  },
  {
    slug: "tam",
    title: "TAM",
    href: "/tam",
    keywords: ["tam", "market", "coverage", "addressable"],
    body: `Market (TAM) sizes ICP universes and tracks coverage: activated → enriched → contacted → replied → deal.
Drill a segment into a list to enrich or enroll.`,
  },
  {
    slug: "enrichment",
    title: "Enrichment jobs",
    href: "/enrichment",
    keywords: ["enrichment", "job", "verify email", "phone", "firmographic"],
    body: `Activate → Enrichment tracks email/phone/firmographic jobs and credit spend.
Run Enrich/Score/Verify from a list detail page.`,
  },
  {
    slug: "draft-auto-approve",
    title: "Draft auto-approve",
    href: "/settings/draft-auto-approve",
    keywords: ["auto-approve", "auto approve", "confidence", "threshold"],
    body: `Settings → Draft auto-approve: set ICP + confidence thresholds. Always-review lists never auto-approve.
Auto-approved drafts still show in AI Review, tagged.`,
  },
  {
    slug: "automation-rules",
    title: "Auto-activation rules",
    href: "/settings/automation-rules",
    keywords: ["automation", "auto-activation", "rule", "threshold", "signal rule"],
    body: `Settings → Automation rules: when score/signal thresholds hit, activate, list, or enroll.
Max 5 active rules.`,
  },
  {
    slug: "alert-notifications",
    title: "Signal alerts",
    href: "/settings/alert-rules",
    keywords: ["alert", "signal", "slack", "notification", "funding", "hiring"],
    body: `Settings → Signal alerts to subscribe to funding/hiring/tech/risk signals.
Settings → Notifications for in-app vs Slack delivery.`,
  },
];

/** Pick the most relevant guide snippets for the latest user message + page. */
export function selectAppGuides(opts: {
  userMessage?: string;
  page?: string;
  limit?: number;
}): AppGuideSnippet[] {
  const limit = opts.limit ?? 6;
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
  if (picked.length >= 1) return picked;
  // Always give a small baseline set so the model knows core product paths.
  return APP_GUIDE_SNIPPETS.slice(0, Math.min(limit, 4));
}

export function appGuidesToPrompt(guides: AppGuideSnippet[]): string {
  if (!guides.length) return "";
  return guides
    .map((g) => `### ${g.title} (${g.href})\n${g.body}`)
    .join("\n\n");
}
