-- Migration: AUTH-BE-02 Email normalization and case-insensitive uniqueness
-- First, check for collisions before making any changes
DO $$
DECLARE
    collision_count integer;
BEGIN
    -- Count how many normalized emails would have duplicates
    SELECT COUNT(*) INTO collision_count
    FROM (
        SELECT trim(lower(email)) as normalized_email
        FROM users
        GROUP BY normalized_email
        HAVING COUNT(*) > 1
    ) t;

    -- If collisions exist, fail the migration
    IF collision_count > 0 THEN
        RAISE EXCEPTION 'Migration failed: % collision(s) detected. Run detect-duplicate-emails.ts to list them and resolve before re-running migration.', collision_count;
    END IF;
END $$;

-- Now normalize all existing emails (trim + lowercase)
UPDATE users
SET email = trim(lower(email));

-- Drop the existing unique constraint on raw email
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_email_unique;

-- Add case-insensitive unique index using lower(email)
CREATE UNIQUE INDEX users_lower_email_unique ON users (lower(email));