-- ===========================================================================
-- Rename vendor-specific columns to vendor-neutral ones.
--
-- The upstream voice provider is an implementation detail, not part of the
-- product. Leaving its name embedded in the schema meant every query, every
-- row type and - through error messages and API payloads - occasionally the
-- customer, carried a vendor name they never bought.
--
-- Renames are metadata-only in Postgres, so this is fast and lossless: no table
-- rewrite, no data movement. Indexes and constraints follow their column
-- automatically; the ones renamed below are for readability only.
--
-- The values themselves are unchanged. A provider id stored yesterday is still
-- the id the upstream expects today.
-- ===========================================================================

ALTER TABLE organizations RENAME COLUMN vapi_mode       TO provider_mode;
ALTER TABLE organizations RENAME COLUMN vapi_key_cipher TO provider_key_cipher;
ALTER TABLE organizations RENAME COLUMN vapi_key_last4  TO provider_key_last4;
ALTER TABLE organizations RENAME COLUMN vapi_key_set_at TO provider_key_set_at;

ALTER TABLE resources RENAME COLUMN vapi_id TO provider_id;

ALTER TABLE calls RENAME COLUMN vapi_call_id TO provider_call_id;

-- Constraint and index names are cosmetic, but a schema dump that still says
-- "vapi" would undo the point of the exercise.
ALTER TABLE organizations RENAME CONSTRAINT organizations_vapi_mode_chk TO organizations_provider_mode_chk;

ALTER INDEX IF EXISTS resources_kind_vapi_id_key RENAME TO resources_kind_provider_id_key;
ALTER INDEX IF EXISTS calls_vapi_call_id_key     RENAME TO calls_provider_call_id_key;
