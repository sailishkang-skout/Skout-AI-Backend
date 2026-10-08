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
}

interface OnboardingTemplate {
  key: string;
  version: number;
  label: string;
  render(input: OnboardingTemplateInput): MailOptions;
}

function body(input: OnboardingTemplateInput, intro: string): { html: string; text: string } {
  const start = input.inviteUrl ?? input.workspaceUrl;
  const steps = input.activationSteps.length > 0 ? input.activationSteps : ["Sign in to your workspace"];
  const trial = input.trialEndsAt ? new Date(input.trialEndsAt).toUTCString().slice(0, 16) : null;
  const html = `
    <p style="margin:0 0 16px;">Hi ${escapeHtml(input.customerName)},</p>
    <p style="margin:0 0 16px;">${escapeHtml(intro)}</p>
    <p style="margin:0 0 24px;"><a href="${escapeHtml(start)}" style="display:inline-block;padding:12px 22px;background:#09090b;color:#fafafa;text-decoration:none;border-radius:8px;font-weight:600;font-size:14px;">Open ${escapeHtml(input.workspaceName)}</a></p>
    <p style="margin:0 0 8px;font-weight:600;">Get to your first result</p>
    <ol style="margin:0 0 20px;padding-left:20px;">${steps.map((s) => `<li style="margin:0 0 6px;">${escapeHtml(s)}</li>`).join("")}</ol>
    ${trial ? `<p style="margin:0 0 16px;">Your trial runs until <strong>${escapeHtml(trial)}</strong>.</p>` : ""}
    <p style="margin:0 0 8px;">Guides and how-tos: <a href="${escapeHtml(input.resourcesUrl)}" style="color:#3f3f46;">${escapeHtml(input.resourcesUrl)}</a></p>
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
    ...(trial ? [`Your trial runs until ${trial}.`, ""] : []),
    `Guides and how-tos: ${input.resourcesUrl}`,
    ...(input.bookingUrl ? [`Book a guided onboarding session: ${input.bookingUrl}`] : []),
    "",
    `Questions? Reply to this email or write to ${input.supportEmail}.`,
  ].join("\n");
  return { html, text };
}

export const ONBOARDING_TEMPLATES: Record<string, OnboardingTemplate> = {
  welcome_trial: {
    key: "welcome_trial",
    version: 1,
    label: "Trial welcome",
    render(input) {
      const { html, text } = body(input, `Your Skout AI trial workspace "${input.workspaceName}" is ready.`);
      return {
        to: input.to,
        subject: `Your Skout AI trial is ready: ${input.workspaceName}`,
        text,
        html: renderTransactionalLayout({ preheader: "Your trial workspace is ready", title: "Welcome to Skout AI", bodyHtml: html }),
      };
    },
  },
  welcome_paid: {
    key: "welcome_paid",
    version: 1,
    label: "Customer welcome",
    render(input) {
      const { html, text } = body(input, `Welcome aboard. Your Skout AI workspace "${input.workspaceName}" is ready.`);
      return {
        to: input.to,
        subject: `Welcome to Skout AI: ${input.workspaceName}`,
        text,
        html: renderTransactionalLayout({ preheader: "Your workspace is ready", title: "Welcome to Skout AI", bodyHtml: html }),
      };
    },
  },
};

/** Trial plans get the trial welcome; any other plan the customer welcome. */
export function chooseOnboardingTemplate(plan: string | null | undefined, override?: string | null): OnboardingTemplate | null {
  if (override) return ONBOARDING_TEMPLATES[override] ?? null;
  return (plan ?? "trial").toLowerCase().includes("trial") ? ONBOARDING_TEMPLATES.welcome_trial! : ONBOARDING_TEMPLATES.welcome_paid!;
}
