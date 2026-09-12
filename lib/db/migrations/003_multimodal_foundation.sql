-- Forward migration: preserve the imported 001/002 history.
BEGIN;
ALTER TABLE participants DROP CONSTRAINT participants_visual_affect_consent_check;
ALTER TABLE participants
  ADD COLUMN voice_affect_consent boolean NOT NULL DEFAULT false,
  ADD COLUMN media_cleanup_pending boolean NOT NULL DEFAULT false;
ALTER TABLE rooms ADD COLUMN media_cleanup_pending boolean NOT NULL DEFAULT false;
ALTER TABLE worker_leases DROP CONSTRAINT worker_leases_video_status_check;
ALTER TABLE worker_leases ADD CONSTRAINT worker_leases_video_status_check
  CHECK (video_status IN ('disabled','starting','ready','error'));
ALTER TABLE mediation_members ADD COLUMN isolation_cutoff_unix_sec bigint;
ALTER TABLE analysis_receipts ADD COLUMN request_hash text;
ALTER TABLE transcript_segments ADD COLUMN time_basis text NOT NULL DEFAULT 'unknown'
  CHECK (time_basis IN ('unknown','receiver_estimate'));
ALTER TABLE private_messages
  ALTER COLUMN reply_status DROP NOT NULL,
  ADD COLUMN processing_started_at timestamptz,
  ADD COLUMN processing_attempt_id uuid;
UPDATE private_messages SET reply_status = NULL WHERE role = 'assistant';
ALTER TABLE mediation_members
  ADD COLUMN ready_to_resume_recommended boolean NOT NULL DEFAULT false,
  ADD COLUMN readiness_message_id uuid REFERENCES private_messages(id) ON DELETE SET NULL;
CREATE UNIQUE INDEX private_messages_one_reply_uidx ON private_messages(reply_to_message_id)
  WHERE role = 'assistant' AND reply_to_message_id IS NOT NULL;
ALTER TABLE private_messages ADD CONSTRAINT private_messages_reply_shape CHECK (
  (role = 'user' AND reply_status IS NOT NULL AND reply_to_message_id IS NULL)
  OR (role = 'assistant' AND reply_status IS NULL AND client_message_id IS NULL)
) NOT VALID;

CREATE TABLE affect_observations (
  id uuid PRIMARY KEY,
  room_id uuid NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  participant_id uuid NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
  source text NOT NULL CHECK (source IN ('visual','voice')),
  track_sid text NOT NULL,
  stream_id uuid NOT NULL,
  consent_revision integer NOT NULL CHECK (consent_revision >= 1),
  sampled_at_ms bigint CHECK (sampled_at_ms >= 0),
  received_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL DEFAULT (clock_timestamp() + interval '24 hours'),
  request_hash text NOT NULL,
  result jsonb NOT NULL CHECK (jsonb_typeof(result) = 'object')
);
CREATE INDEX affect_observations_owner_idx ON affect_observations(room_id,participant_id,received_at DESC);
CREATE INDEX affect_observations_expiry_idx ON affect_observations(expires_at);
ALTER TABLE affect_observations ENABLE ROW LEVEL SECURITY;
-- Only the backend accesses observations; owner reads are projected by API-28.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN
    REVOKE ALL ON rooms, participants, transcript_segments, mind_map_nodes,
      mediation_members, private_messages FROM authenticated;
    GRANT SELECT ON room_events TO authenticated;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN
    GRANT ALL ON affect_observations TO service_role;
  END IF;
END $$;
CREATE OR REPLACE FUNCTION requesting_auth_user_id() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT COALESCE(NULLIF(current_setting('request.jwt.claim.sub',true),''),
    NULLIF(current_setting('request.jwt.claims',true),'')::jsonb->>'sub')::uuid
$$;
COMMIT;
