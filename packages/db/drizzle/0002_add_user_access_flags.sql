ALTER TABLE "users"
  ADD COLUMN "status" text NOT NULL DEFAULT 'active',
  ADD COLUMN "is_blocked" boolean NOT NULL DEFAULT false;
