CREATE TABLE IF NOT EXISTS "workspace_invites" (
  "id"                  uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "workspace_id"        uuid NOT NULL REFERENCES "public"."workspaces"("id") ON DELETE CASCADE,
  "invited_by_user_id"  uuid REFERENCES "public"."users"("id") ON DELETE SET NULL,
  "email"               text NOT NULL,
  "role"                text NOT NULL DEFAULT 'member',
  "token"               text NOT NULL,
  "expires_at"          timestamp with time zone NOT NULL,
  "accepted_at"         timestamp with time zone,
  "created_at"          timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "workspace_invites_token_unique" UNIQUE("token")
);
