ALTER TABLE "users" ADD COLUMN "clerk_user_id" text;
CREATE UNIQUE INDEX "users_clerk_user_id_unique" ON "users" ("clerk_user_id");
