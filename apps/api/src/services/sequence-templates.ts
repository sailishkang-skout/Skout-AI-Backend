import type { ConditionType, SequenceMode, SequenceSource, StepType } from "./sequence.service.js";
import { LINKEDIN_ACTIONS } from "./sequence.service.js";

export interface SequenceTemplateStep {
  stepType: StepType;
  delayDays: number;
  delayUnit?: "minutes" | "hours" | "days" | "weeks";
  linkedinAction?: (typeof LINKEDIN_ACTIONS)[number];
  subject?: string | null;
  bodyTemplate?: string | null;
  conditionType?: ConditionType | null;
  conditionWaitDays?: number;
  branch?: "yes" | "no" | null;
  goalLabel?: string | null;
}

export interface SequenceTemplate {
  key: string;
  name: string;
  description: string;
  channels: string[];
  source: SequenceSource;
  mode: SequenceMode;
  steps: SequenceTemplateStep[];
}

export const SEQUENCE_TEMPLATES: SequenceTemplate[] = [
  {
    key: "linkedin-first-connect",
    name: "B — LinkedIn first",
    description: "Connect on LinkedIn, wait for accept, then message or email fallback.",
    channels: ["linkedin", "email"],
    source: "template",
    mode: "B",
    steps: [
      {
        stepType: "linkedin",
        delayDays: 0,
        delayUnit: "days",
        linkedinAction: "connect",
        bodyTemplate: "Hi {{firstName}} — I'd love to connect. We help teams like {{companyName}} book more qualified meetings.",
      },
      {
        stepType: "condition",
        delayDays: 0,
        conditionType: "linkedin_invite_accepted",
        conditionWaitDays: 3,
      },
      {
        stepType: "linkedin",
        delayDays: 1,
        linkedinAction: "message",
        branch: "yes",
        bodyTemplate: "Thanks for connecting, {{firstName}}. Open to a 15-min chat on how {{companyName}} handles outbound?",
      },
      {
        stepType: "email",
        delayDays: 1,
        branch: "no",
        subject: "{{firstName}}, quick intro from Skout",
        bodyTemplate: "Hi {{firstName}},\n\nI reached out on LinkedIn — sharing a short note here in case that's easier.\n\nWould a 15-minute intro next week work?\n\nBest,\n{{senderName}}",
      },
      {
        stepType: "goal",
        delayDays: 0,
        goalLabel: "Meeting booked",
      },
    ],
  },
  {
    key: "saas-vp-email",
    name: "A — Standard outreach",
    description: "Balanced email + LinkedIn cadence. Safe defaults, minimal setup.",
    channels: ["email", "linkedin"],
    source: "template",
    mode: "A",
    steps: [
      {
        stepType: "email",
        delayDays: 0,
        subject: "{{firstName}} — list-building time at {{companyName}}",
        bodyTemplate: "Hi {{firstName}},\n\nMost RevOps teams still spend hours stitching lists together. We built Skout so {{companyName}} can go from ICP to enrolled sequence in one workspace.\n\nWorth a look?\n\n{{senderName}}",
      },
      { stepType: "linkedin", delayDays: 1, linkedinAction: "like" },
      {
        stepType: "linkedin",
        delayDays: 1,
        linkedinAction: "connect",
        bodyTemplate: "Hi {{firstName}}, following up on my note — happy to share how similar SaaS teams cut list-building time.",
      },
      {
        stepType: "email",
        delayDays: 3,
        subject: "Re: {{companyName}} outbound",
        bodyTemplate: "Hi {{firstName}},\n\nCircling back once. If outbound list-building isn't a priority this quarter, no worries — just say the word.\n\n{{senderName}}",
      },
      { stepType: "goal", delayDays: 0, goalLabel: "Demo booked" },
    ],
  },
  {
    key: "multi-channel-demo",
    name: "Multi-channel demo push",
    description: "Email + WhatsApp + call with click condition. Good God Mode starting point.",
    channels: ["email", "whatsapp", "call"],
    source: "template",
    mode: "C",
    steps: [
      {
        stepType: "email",
        delayDays: 0,
        subject: "Quick idea for {{companyName}}",
        bodyTemplate: "Hi {{firstName}},\n\nWe help teams book more qualified demos without extra SDRs. 12-minute walkthrough here: {{unsubscribeUrl}}\n\n{{senderName}}",
      },
      {
        stepType: "condition",
        delayDays: 0,
        conditionType: "email_clicked",
        conditionWaitDays: 2,
      },
      {
        stepType: "email",
        delayDays: 1,
        branch: "yes",
        subject: "Thanks for clicking — next step?",
        bodyTemplate: "Hi {{firstName}},\n\nSaw you opened the walkthrough. Want me to hold 15 minutes this week?\n\n{{senderName}}",
      },
      {
        stepType: "whatsapp",
        delayDays: 1,
        branch: "no",
        bodyTemplate: "Hi {{firstName}} — sent a short note about demo booking. Open to a quick chat?",
      },
      { stepType: "call", delayDays: 2 },
      { stepType: "goal", delayDays: 0, goalLabel: "Demo booked" },
    ],
  },
];

export function getSequenceTemplate(key: string): SequenceTemplate | undefined {
  return SEQUENCE_TEMPLATES.find((t) => t.key === key);
}
