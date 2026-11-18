import type { MailOptions } from "./mail.service.js";
import { escapeHtml, renderTransactionalLayout } from "./mail.service.js";

/**
 * COPS-05 onboarding email templates (Bible p.41): workspace link, activation steps, knowledge
 * resources, booking link and support path. Chosen by trial type; every change bumps `version`,
 * and the version is stored on the send so history is never rewritten. COPS-07 moves these into
 * versioned admin config (per segment).
 */
export interface OnboardingTemplateInput {
  to: string;
  customerName: string;
  workspaceName: string;
  workspaceUrl: string;
  inviteUrl: string | null;
  trialEndsAt: string | null;
  activationSteps: string[];
  bookingUrl: string | null;
  resourcesUrl: string;
  supportEmail: string;
  /** Enterprise variant adds the kickoff / success-plan paragraph. */
  enterprise?: boolean;
  /** COPS-07: the workspace's own wording for this template (admin config `email_template`). */
  override?: { subject: string; intro: string; closing?: string } | null;
}

interface OnboardingTemplate {
  key: string;
  version: number;
  label: string;
  /** The built-in wording, with {{workspace}} / {{name}} placeholders (what admins start editing from). */
  defaults: { subject: string; intro: string; closing: string };
  render(input: OnboardingTemplateInput): MailOptions;
}

export type Segment = "smb" | "mid_market" | "enterprise";

/** Account segment from company size (accounts have no segment field yet). Unknown size counts as SMB. */
export function segmentOf(employeeCount: number | null | undefined): Segment {
  if (!employeeCount || employeeCount < 200) return "smb";
  return employeeCount < 1000 ? "mid_market" : "enterprise";
}

const ENTERPRISE_NOTE = "Your account team will reach out to schedule a kickoff with your stakeholders and agree the success plan.";

/** Placeholders admins can use in their wording. */
export const TEMPLATE_VARIABLES = [
  { token: "{{workspace}}", description: "Customer workspace name" },
  { token: "{{name}}", description: "Recipient first name" },
] as const;

/** {{workspace}} becomes the customer workspace name; {{name}} the recipient's first name. */
export const fillTemplateText = (text: string, input: Pick<OnboardingTemplateInput, "workspaceName"> & { customerName?: string }) =>
  text.replace(/\{\{\s*workspace\s*\}\}/g, input.workspaceName).replace(/\{\{\s*name\s*\}\}/g, input.customerName ?? "there");

function body(input: OnboardingTemplateInput, defaultIntro: string): { html: string; text: string } {
  const intro = fillTemplateText(input.override ? input.override.intro : defaultIntro, input);
  const closing = input.override?.closing ? fillTemplateText(input.override.closing, input) : null;
  const start = input.inviteUrl ?? input.workspaceUrl;
  const steps = input.activationSteps.length > 0 ? input.activationSteps : ["Sign in to your workspace"];
  const trial = input.trialEndsAt ? new Date(input.trialEndsAt).toUTCString().slice(0, 16) : null;
  const html = `
    <p style="margin:0 0 16px;">Hi ${escapeHtml(input.customerName)},</p>
    <p style="margin:0 0 16px;">${escapeHtml(intro)}</p>
    <p style="margin:0 0 24px;"><a href="${escapeHtml(start)}" style="display:inline-block;padding:12px 22px;background:#09090b;color:#fafafa;text-decoration:none;border-radius:8px;font-weight:600;font-size:14px;">Open ${escapeHtml(input.workspaceName)}</a></p>
    <p style="margin:0 0 8px;font-weight:600;">Get to your first result</p>
    <ol style="margin:0 0 20px;padding-left:20px;">${steps.map((s) => `<li style="margin:0 0 6px;">${escapeHtml(s)}</li>`).join("")}</ol>
    ${input.enterprise ? `<p style="margin:0 0 16px;">${escapeHtml(ENTERPRISE_NOTE)}</p>` : ""}
    ${trial ? `<p style="margin:0 0 16px;">Your trial runs until <strong>${escapeHtml(trial)}</strong>.</p>` : ""}
    <p style="margin:0 0 8px;">Guides and how-tos: <a href="${escapeHtml(input.resourcesUrl)}" style="color:#3f3f46;">${escapeHtml(input.resourcesUrl)}</a></p>
    ${closing ? `<p style="margin:0 0 16px;">${escapeHtml(closing)}</p>` : ""}
    ${input.bookingUrl ? `<p style="margin:0 0 8px;">Book a guided onboarding session: <a href="${escapeHtml(input.bookingUrl)}" style="color:#3f3f46;">${escapeHtml(input.bookingUrl)}</a></p>` : ""}
    <p style="margin:16px 0 0;font-size:12px;color:#71717a;">Questions? Reply to this email or write to ${escapeHtml(input.supportEmail)}.</p>
  `;
  const text = [
    `Hi ${input.customerName},`,
    "",
    intro,
    "",
    `Open your workspace: ${start}`,
    "",
    "Get to your first result:",
    ...steps.map((s, i) => `${i + 1}. ${s}`),
    "",
    ...(input.enterprise ? [ENTERPRISE_NOTE, ""] : []),
    ...(trial ? [`Your trial runs until ${trial}.`, ""] : []),
    `Guides and how-tos: ${input.resourcesUrl}`,
    ...(closing ? [closing] : []),
    ...(input.bookingUrl ? [`Book a guided onboarding session: ${input.bookingUrl}`] : []),
    "",
    `Questions? Reply to this email or write to ${input.supportEmail}.`,
  ].join("\n");
  return { html, text };
}

function enterpriseVariant(base: OnboardingTemplate, key: string, label: string): OnboardingTemplate {
  return { key, version: 1, label, defaults: base.defaults, render: (input) => base.render({ ...input, enterprise: true }) };
}

const TRIAL_DEFAULTS = { subject: "Your Skout AI trial is ready: {{workspace}}", intro: 'Your Skout AI trial workspace "{{workspace}}" is ready.', closing: "" };
const PAID_DEFAULTS = { subject: "Welcome to Skout AI: {{workspace}}", intro: 'Welcome aboard. Your Skout AI workspace "{{workspace}}" is ready.', closing: "" };

const BASE_TEMPLATES: Record<string, OnboardingTemplate> = {
  welcome_trial: {
    key: "welcome_trial",
    version: 1,
    label: "Trial welcome",
    defaults: TRIAL_DEFAULTS,
    render(input) {
      const { html, text } = body(input, TRIAL_DEFAULTS.intro);
      return {
        to: input.to,
        subject: fillTemplateText(input.override ? input.override.subject : TRIAL_DEFAULTS.subject, input),
        text,
        html: renderTransactionalLayout({ preheader: "Your trial workspace is ready", title: "Welcome to Skout AI", bodyHtml: html }),
      };
    },
  },
  welcome_paid: {
    key: "welcome_paid",
    version: 1,
    label: "Customer welcome",
    defaults: PAID_DEFAULTS,
    render(input) {
      const { html, text } = body(input, PAID_DEFAULTS.intro);
      return {
        to: input.to,
        subject: fillTemplateText(input.override ? input.override.subject : PAID_DEFAULTS.subject, input),
        text,
        html: renderTransactionalLayout({ preheader: "Your workspace is ready", title: "Welcome to Skout AI", bodyHtml: html }),
      };
    },
  },
};

export const ONBOARDING_TEMPLATES: Record<string, OnboardingTemplate> = {
  ...BASE_TEMPLATES,
  welcome_trial_enterprise: enterpriseVariant(BASE_TEMPLATES.welcome_trial!, "welcome_trial_enterprise", "Trial welcome (enterprise)"),
  welcome_paid_enterprise: enterpriseVariant(BASE_TEMPLATES.welcome_paid!, "welcome_paid_enterprise", "Customer welcome (enterprise)"),
};

/** Template by trial type and segment (Bible p.41): trial vs paid, and the enterprise variant for enterprise accounts. */
export function chooseOnboardingTemplate(
  plan: string | null | undefined,
  override?: string | null,
  segment: Segment = "smb"
): OnboardingTemplate | null {
  if (override) return ONBOARDING_TEMPLATES[override] ?? null;
  const kind = (plan ?? "trial").toLowerCase().includes("trial") ? "welcome_trial" : "welcome_paid";
  return ONBOARDING_TEMPLATES[segment === "enterprise" ? `${kind}_enterprise` : kind]!;
}

/** Sample data for the admin preview: shows every part of the email (trial date, steps, booking link). */
export function previewOnboardingTemplate(
  key: string,
  override: { subject: string; intro: string; closing?: string } | null,
  sample: { workspaceName?: string; customerName?: string; appBaseUrl: string; resourcesUrl: string; supportEmail: string }
): MailOptions | null {
  const template = ONBOARDING_TEMPLATES[key];
  if (!template) return null;
  return template.render({
    override,
    to: "priya@example.com",
    customerName: sample.customerName ?? "Priya",
    workspaceName: sample.workspaceName ?? "Acme Corp",
    workspaceUrl: sample.appBaseUrl,
    inviteUrl: null,
    trialEndsAt: key.startsWith("welcome_trial") ? new Date(Date.now() + 14 * 86_400_000).toISOString() : null,
    activationSteps: ["Connect your CRM", "Import your first list", "Launch your first sequence"],
    bookingUrl: "https://cal.example.com/skout-onboarding",
    resourcesUrl: sample.resourcesUrl,
    supportEmail: sample.supportEmail,
  });
}
