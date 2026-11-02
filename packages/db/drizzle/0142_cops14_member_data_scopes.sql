-- COPS-14 part C (data scope): a member can be limited to their own accounts (owner or CSM).
-- No row means no limit, so existing members are unchanged.
CREATE TABLE IF NOT EXISTS "cops_member_data_scopes" (
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "scope" text NOT NULL,
  "set_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "reason" text NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "cops_member_data_scopes_pk" PRIMARY KEY ("workspace_id", "user_id"),
  CONSTRAINT "cops_member_data_scopes_scope_check" CHECK ("scope" IN ('own_accounts'))
);
