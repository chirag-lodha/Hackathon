-- Let Postgres generate image ids instead of the Go layer. gen_random_uuid()
-- is built-in on PG13+; pgcrypto provides it on older servers (harmless if
-- already present). The id column stays TEXT, so cast the uuid to text.
CREATE EXTENSION IF NOT EXISTS "pgcrypto";
ALTER TABLE images ALTER COLUMN id SET DEFAULT gen_random_uuid()::text;
