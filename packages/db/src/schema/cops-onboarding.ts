import { boolean, integer, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { workspaces } from "./workspaces.js";
import { companies, contacts, tasks } from "./crm.js";
import { copsProvisionings } from "./cops-provisioning.js";
import { sequenceEnrollments } from "./sequences.js";

/**
 * COPS-05 onboarding email sends. One row per send attempt that passed canContact(); the
 * Idempotency-Key makes a double click send once, and a partial unique index (migration 0113)
 * allows one first send per account and recipient. Re-sends carry is_resend + reason (audited).
 */
export const copsOnboardingEmailSends = pgTable("cops_onboarding_email_sends", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id")
    .notNull()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  accountId: uuid("account_id")
    .notNull()
    .references(() => companies.id, { onDelete: "cascade" }),
  provisioningId: uuid("provisioning_id").references(() => copsProvisionings.id, { onDelete: "set null" }),
  contactId: uuid("contact_id").references(() => contacts.id, { onDelete: "set null" }),
  toEmail: text("to_email").notNull(),
  templateKey: text("template_key").notNull(),
  templateVersion: integer("template_version").notNull(),
  subject: text("subject").notNull(),
  idempotencyKey: text("idempotency_key").notNull(),
  /** queued | sent | delivered | bounced | failed */
  status: text("status").notNull().default("queued"),
  providerMessageId: text("provider_message_id"),
  isResend: boolean("is_resend").notNull().default(false),
  reason: text("reason"),
  actorId: uuid("actor_id"),
  error: text("error"),
  sentAt: timestamp("sent_at", { withTimezone: true }),
  deliveredAt: timestamp("delivered_at", { withTimezone: true }),
  bouncedAt: timestamp("bounced_at", { withTimezone: true }),
  openedAt: timestamp("opened_at", { withTimezone: true }),
  clickedAt: timestamp("clicked_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * The follow-up that a WelcomeEmailSent produced: exactly one of a sequence enrollment or an
 * enrollment task (acceptance: 100% of WelcomeEmailSent events yield one, never neither).
 * Unique on the source event, so a redelivered event is a no-op.
 */
export const copsFollowUps = pgTable("cops_follow_ups", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id")
    .notNull()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  accountId: uuid("account_id")
    .notNull()
    .references(() => companies.id, { onDelete: "cascade" }),
  sourceEventId: uuid("source_event_id").notNull(),
  emailSendId: uuid("email_send_id").references(() => copsOnboardingEmailSends.id, { onDelete: "set null" }),
  /** sequence | task */
  mode: text("mode").notNull(),
  enrollmentId: uuid("enrollment_id").references(() => sequenceEnrollments.id, { onDelete: "set null" }),
  taskId: uuid("task_id").references(() => tasks.id, { onDelete: "set null" }),
  /** Why a task was created instead of an enrollment (e.g. contact_without_prospect, no_sequence_configured). */
  taskReason: text("task_reason"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Activation template: weighted milestones per product/segment. A change is a new version; an
 * instance keeps the version it started with, so past activations are never rewritten.
 */
export const copsActivationTemplates = pgTable("cops_activation_templates", {
  id: uuid("id").primaryKey().defaultRandom(),
  /** Null = system default available to every workspace. */
  workspaceId: uuid("workspace_id").references(() => workspaces.id, { onDelete: "cascade" }),
  key: text("key").notNull(),
  version: integer("version").notNull(),
  segment: text("segment"),
  /** [{ key, label, weight, required, source: event|manual, event_types: [] }] */
  milestones: jsonb("milestones").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const copsOnboardingInstances = pgTable("cops_onboarding_instances", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id")
    .notNull()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  accountId: uuid("account_id")
    .notNull()
    .references(() => companies.id, { onDelete: "cascade" }),
  provisioningId: uuid("provisioning_id").references(() => copsProvisionings.id, { onDelete: "set null" }),
  /** The provisioned customer workspace whose product events satisfy milestones. */
  customerWorkspaceId: uuid("customer_workspace_id").references(() => workspaces.id, { onDelete: "set null" }),
  templateId: uuid("template_id")
    .notNull()
    .references(() => copsActivationTemplates.id),
  templateKey: text("template_key").notNull(),
  templateVersion: integer("template_version").notNull(),
  activationPct: integer("activation_pct").notNull().default(0),
  firstLoginAt: timestamp("first_login_at", { withTimezone: true }),
  activatedAt: timestamp("activated_at", { withTimezone: true }),
  handoffTaskId: uuid("handoff_task_id").references(() => tasks.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const copsOnboardingMilestones = pgTable("cops_onboarding_milestones", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id")
    .notNull()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  instanceId: uuid("instance_id")
    .notNull()
    .references(() => copsOnboardingInstances.id, { onDelete: "cascade" }),
  key: text("key").notNull(),
  label: text("label").notNull(),
  weight: integer("weight").notNull(),
  required: boolean("required").notNull().default(false),
  /** event | manual */
  source: text("source").notNull(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  evidence: jsonb("evidence"),
});

/** Every event or manual action that touched a milestone (evidence trail, duplicates are no-ops). */
export const copsMilestoneEvents = pgTable("cops_milestone_events", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id")
    .notNull()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  milestoneId: uuid("milestone_id")
    .notNull()
    .references(() => copsOnboardingMilestones.id, { onDelete: "cascade" }),
  /** Source event id or manual idempotency key; unique per milestone. */
  sourceRef: text("source_ref").notNull(),
  sourceType: text("source_type").notNull(),
  actorId: uuid("actor_id"),
  reason: text("reason"),
  occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Stalled-onboarding triggers fire once per instance and trigger (unique index). */
export const copsOnboardingSignals = pgTable("cops_onboarding_signals", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id")
    .notNull()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  instanceId: uuid("instance_id")
    .notNull()
    .references(() => copsOnboardingInstances.id, { onDelete: "cascade" }),
  /** no_delivery | delivered_no_login | no_login_24h | login_no_value | no_activity_72h | integration_error | low_credits | trial_ending */
  trigger: text("trigger").notNull(),
  taskId: uuid("task_id").references(() => tasks.id, { onDelete: "set null" }),
  firedAt: timestamp("fired_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Per-workspace onboarding settings. Appendix C: stop the follow-up on a critical escalation, if configured (default off). */
export const copsOnboardingSettings = pgTable("cops_onboarding_settings", {
  workspaceId: uuid("workspace_id")
    .primaryKey()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  stopOnCriticalEscalation: boolean("stop_on_critical_escalation").notNull().default(false),
  updatedBy: uuid("updated_by"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
