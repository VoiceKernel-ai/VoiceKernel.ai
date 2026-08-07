-- ===========================================================================
-- Integration partner applications.
--
-- Submitted from the public partners page by system integrators who want to
-- build on VoiceKernel. Unauthenticated by necessity: an applicant has no
-- account yet, and requiring one would invert the funnel.
--
-- Nothing here is a tenant resource, so it deliberately has no org_id. It is
-- inbound interest, reviewed by whoever runs the partner programme.
-- ===========================================================================

CREATE TABLE IF NOT EXISTS partner_applications (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  company        TEXT NOT NULL,
  website        TEXT,
  contact_name   TEXT NOT NULL,
  contact_email  TEXT NOT NULL,
  country        TEXT,

  -- What they build and who for, in their words. Free text on purpose: a
  -- dropdown of categories would tell us what we already believe rather than
  -- what they actually do.
  focus          TEXT,
  message        TEXT,

  -- 'new' -> 'reviewing' -> 'accepted' | 'declined'
  status         TEXT NOT NULL DEFAULT 'new'
                 CONSTRAINT partner_applications_status_chk
                 CHECK (status IN ('new', 'reviewing', 'accepted', 'declined')),

  -- Kept for abuse triage only; not used to identify anyone.
  source_ip      TEXT,
  user_agent     TEXT,

  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One application per company email. A second submission updates the first
-- rather than creating a duplicate queue entry for the reviewer.
CREATE UNIQUE INDEX IF NOT EXISTS partner_applications_email_key
  ON partner_applications (lower(contact_email));

CREATE INDEX IF NOT EXISTS partner_applications_status_idx
  ON partner_applications (status, created_at DESC);
