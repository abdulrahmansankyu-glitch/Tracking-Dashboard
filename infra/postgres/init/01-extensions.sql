-- Extensions required by Intoto ERP.
-- Runs automatically on first container start (docker-entrypoint-initdb.d).

-- Fuzzy / trigram search: powers global search and "natural language search" fallback
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Accent-insensitive matching for customer/supplier names
CREATE EXTENSION IF NOT EXISTS unaccent;

-- UUID generation (gen_random_uuid is in pgcrypto / core since PG13)
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Query performance introspection for the ops runbook
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;

-- Case-insensitive text (emails, GSTINs)
CREATE EXTENSION IF NOT EXISTS citext;
