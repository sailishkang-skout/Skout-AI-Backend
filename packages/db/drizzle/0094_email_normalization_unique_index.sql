-- Migration: AUTH-BE-02 Email normalization and case-insensitive uniqueness
--
-- Fails safe: if normalizing would make two users share an email, this changes nothing and only
-- raises a NOTICE with the collision count (the ticket's "does nothing destructive ... and prints
-- the count"). Deploys are not blocked. Resolve collisions by hand with
-- apps/api/scripts/detect-duplicate-emails.ts, then create the index manually (it is not retried).
--
-- Expand-only (Ground Rule 2): the original users_email_unique constraint is kept, not dropped.
-- invite-auth.routes.ts upserts with ON CONFLICT (email), which needs that exact constraint; the
-- new lower(email) index sits alongside it.
DO $$
DECLARE
    collision_count integer;
BEGIN
    SELECT COUNT(*) INTO collision_count
    FROM (
        SELECT lower(trim(email)) AS normalized_email
        FROM users
        GROUP BY normalized_email
        HAVING COUNT(*) > 1
    ) t;

    IF collision_count > 0 THEN
        RAISE NOTICE 'AUTH-BE-02: % normalized-email collision(s) found; skipped email normalization and the users_lower_email_unique index. Run detect-duplicate-emails.ts and resolve them first.', collision_count;
        RETURN;
    END IF;

    UPDATE users SET email = lower(trim(email)) WHERE email <> lower(trim(email));

    CREATE UNIQUE INDEX IF NOT EXISTS users_lower_email_unique ON users (lower(email));
END $$;
