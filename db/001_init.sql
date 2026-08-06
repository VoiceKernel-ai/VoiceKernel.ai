-- ===========================================================================
-- VoiceKernel - initial schema
--
-- Design notes
--  * Every tenant-owned row carries org_id and is filtered by it. There is no
--    "global" read path in the application outside of the admin surface.
--  * `resources` is the ownership registry. VoiceKernel proxies to Vapi, and in
--    platform mode many tenants share one Vapi account - so Vapi's own IDs are
--    not a trust boundary. This table is. Every id-scoped proxy call resolves
--    (kind, vapi_id) -> org_id here before it is allowed through.
--  * `snapshot` holds the last known Vapi representation so list endpoints do
--    not fan out N+1 requests to Vapi just to render a table.
-- ===========================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- --------------------------------------------------------------------------
-- Tenancy
-- --------------------------------------------------------------------------

CREATE TABLE organizations (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name             TEXT        NOT NULL,
  slug             TEXT        NOT NULL UNIQUE,
  plan             TEXT        NOT NULL DEFAULT 'trial',
  status           TEXT        NOT NULL DEFAULT 'active',

  -- 'platform' = VoiceKernel's Vapi account, isolation enforced by us.
  -- 'byo'      = tenant supplies their own Vapi key; their account, their data.
  vapi_mode        TEXT        NOT NULL DEFAULT 'platform',
  vapi_key_cipher  TEXT,                      -- AES-256-GCM, see lib/crypto.ts
  vapi_key_last4   TEXT,
  vapi_key_set_at  TIMESTAMPTZ,

  region           TEXT        NOT NULL DEFAULT 'us-east',
  settings         JSONB       NOT NULL DEFAULT '{}'::jsonb,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT organizations_vapi_mode_chk CHECK (vapi_mode IN ('platform','byo')),
  CONSTRAINT organizations_status_chk    CHECK (status IN ('active','suspended','deleted'))
);

CREATE TABLE users (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Normalised to lowercase in the application (services/auth.ts) so a plain
  -- unique index is enough and we avoid depending on the citext extension.
  email          TEXT        NOT NULL UNIQUE,
  password_hash  TEXT        NOT NULL,
  name           TEXT,
  status         TEXT        NOT NULL DEFAULT 'active',
  last_login_at  TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT users_status_chk CHECK (status IN ('active','disabled'))
);

CREATE TABLE memberships (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id     UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role       TEXT NOT NULL DEFAULT 'developer',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (org_id, user_id),
  CONSTRAINT memberships_role_chk CHECK (role IN ('owner','admin','developer','viewer'))
);
CREATE INDEX memberships_user_idx ON memberships (user_id);

CREATE TABLE refresh_tokens (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX refresh_tokens_user_idx ON refresh_tokens (user_id);

-- --------------------------------------------------------------------------
-- API keys
--
-- Only the hash is stored. `prefix` is the searchable public half so a lookup
-- is one indexed hit rather than a scan-and-compare over every key.
-- --------------------------------------------------------------------------

CREATE TABLE api_keys (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  environment  TEXT NOT NULL DEFAULT 'live',
  prefix       TEXT NOT NULL UNIQUE,
  key_hash     TEXT NOT NULL,
  last4        TEXT NOT NULL,
  scopes       TEXT[] NOT NULL DEFAULT ARRAY['*']::text[],
  last_used_at TIMESTAMPTZ,
  expires_at   TIMESTAMPTZ,
  revoked_at   TIMESTAMPTZ,
  created_by   UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT api_keys_env_chk CHECK (environment IN ('live','test'))
);
CREATE INDEX api_keys_org_idx ON api_keys (org_id);

-- --------------------------------------------------------------------------
-- Ownership registry - the tenant isolation boundary for proxied resources
-- --------------------------------------------------------------------------

CREATE TABLE resources (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id     UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL,        -- assistant | call | phoneNumber | squad | tool | file | knowledgeBase | workflow | ...
  vapi_id    TEXT NOT NULL,
  name       TEXT,
  snapshot   JSONB NOT NULL DEFAULT '{}'::jsonb,
  metadata   JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ,
  UNIQUE (kind, vapi_id)
);
CREATE INDEX resources_org_kind_idx     ON resources (org_id, kind, created_at DESC);
CREATE INDEX resources_org_kind_live_idx ON resources (org_id, kind) WHERE deleted_at IS NULL;

-- --------------------------------------------------------------------------
-- Calls - denormalised for dashboards and analytics without hammering Vapi
-- --------------------------------------------------------------------------

CREATE TABLE calls (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id           UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  vapi_call_id     TEXT NOT NULL UNIQUE,
  assistant_id     TEXT,
  squad_id         TEXT,
  phone_number_id  TEXT,
  type             TEXT,
  status           TEXT,
  ended_reason     TEXT,
  customer_number  TEXT,
  direction        TEXT,
  started_at       TIMESTAMPTZ,
  ended_at         TIMESTAMPTZ,
  duration_seconds NUMERIC(12,3),
  cost             NUMERIC(12,6),
  cost_breakdown   JSONB,
  transcript       TEXT,
  summary          TEXT,
  recording_url    TEXT,
  analysis         JSONB,
  raw              JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX calls_org_created_idx ON calls (org_id, created_at DESC);
CREATE INDEX calls_org_status_idx  ON calls (org_id, status);
CREATE INDEX calls_assistant_idx   ON calls (org_id, assistant_id);

-- --------------------------------------------------------------------------
-- Events + outbound webhooks
-- --------------------------------------------------------------------------

CREATE TABLE events (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  type          TEXT NOT NULL,
  resource_kind TEXT,
  resource_id   TEXT,
  payload       JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX events_org_created_idx ON events (org_id, created_at DESC);
CREATE INDEX events_org_type_idx    ON events (org_id, type, created_at DESC);

CREATE TABLE webhook_endpoints (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  url           TEXT NOT NULL,
  description   TEXT,
  secret_cipher TEXT NOT NULL,
  secret_last4  TEXT NOT NULL,
  events        TEXT[] NOT NULL DEFAULT ARRAY['*']::text[],
  enabled       BOOLEAN NOT NULL DEFAULT true,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX webhook_endpoints_org_idx ON webhook_endpoints (org_id);

CREATE TABLE webhook_deliveries (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  endpoint_id     UUID NOT NULL REFERENCES webhook_endpoints(id) ON DELETE CASCADE,
  event_id        UUID REFERENCES events(id) ON DELETE SET NULL,
  event_type      TEXT NOT NULL,
  payload         JSONB NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending',
  attempts        INT  NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  response_status INT,
  response_body   TEXT,
  error           TEXT,
  delivered_at    TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT webhook_deliveries_status_chk CHECK (status IN ('pending','delivering','succeeded','failed','dead'))
);
-- Partial index: the worker only ever scans the pending queue.
CREATE INDEX webhook_deliveries_queue_idx ON webhook_deliveries (next_attempt_at)
  WHERE status = 'pending';
CREATE INDEX webhook_deliveries_org_idx ON webhook_deliveries (org_id, created_at DESC);

-- --------------------------------------------------------------------------
-- Audit, idempotency, usage
-- --------------------------------------------------------------------------

CREATE TABLE audit_logs (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        UUID REFERENCES organizations(id) ON DELETE CASCADE,
  actor_type    TEXT NOT NULL,       -- user | api_key | system
  actor_id      TEXT,
  actor_label   TEXT,
  action        TEXT NOT NULL,
  resource_kind TEXT,
  resource_id   TEXT,
  status        INT,
  ip            TEXT,
  user_agent    TEXT,
  metadata      JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX audit_logs_org_created_idx ON audit_logs (org_id, created_at DESC);

CREATE TABLE idempotency_keys (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  key             TEXT NOT NULL,
  request_hash    TEXT NOT NULL,
  response_status INT,
  response_body   JSONB,
  completed_at    TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (org_id, key)
);
CREATE INDEX idempotency_keys_created_idx ON idempotency_keys (created_at);

CREATE TABLE usage_records (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id     UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  period     DATE NOT NULL,
  metric     TEXT NOT NULL,
  quantity   NUMERIC(18,6) NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (org_id, period, metric)
);

-- --------------------------------------------------------------------------
-- updated_at maintenance
-- --------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER organizations_updated_at BEFORE UPDATE ON organizations
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER users_updated_at BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER resources_updated_at BEFORE UPDATE ON resources
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER calls_updated_at BEFORE UPDATE ON calls
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER webhook_endpoints_updated_at BEFORE UPDATE ON webhook_endpoints
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
