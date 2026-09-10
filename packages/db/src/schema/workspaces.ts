import { boolean, integer, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

export const workspaces = pgTable("workspaces", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  /** R17.4 — incoming webhook URL for this workspace's Slack app, if connected. Null = Slack channel disabled. */
  slackWebhookUrl: text("slack_webhook_url"),
  /** R16.2 — default for new meetings' auto-join-bot flag; explicit true/false wins over this. */
  meetingBotAutoJoinDefault: boolean("meeting_bot_auto_join_default").notNull().default(false),
  /** Score threshold (0-100) above which a scored prospect is flagged as a promotion candidate. */
  dealPromotionThreshold: integer("deal_promotion_threshold").notNull().default(80),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
