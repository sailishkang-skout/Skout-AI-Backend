-- COPS-15: an invite from the ops portal can carry Ops access, granted when it is accepted.
ALTER TABLE "workspace_invites" ADD COLUMN IF NOT EXISTS "grant_ops_access" boolean NOT NULL DEFAULT false;
