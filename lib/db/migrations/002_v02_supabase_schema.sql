-- Conflict Mitigator v0.2 schema completion.
-- Safe to apply after 001_initial_schema.sql. This migration is written to run
-- on PostgreSQL 16 and Supabase Postgres; Supabase-specific grants/publication
-- changes are conditional so the plain local Docker database remains usable.
BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Existing ownership relationships become deletion-safe. Deleting a room must
-- remove its business data, including private messages, without retaining raw
-- mediation content in orphan rows.
ALTER TABLE participants
    DROP CONSTRAINT participants_room_id_fkey,
    ADD CONSTRAINT participants_room_id_fkey
        FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE CASCADE;
ALTER TABLE transcript_segments
    DROP CONSTRAINT transcript_segments_room_id_fkey,
    DROP CONSTRAINT transcript_segments_participant_id_fkey,
    ADD CONSTRAINT transcript_segments_room_id_fkey
        FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE CASCADE,
    ADD CONSTRAINT transcript_segments_participant_id_fkey
        FOREIGN KEY (participant_id) REFERENCES participants(id) ON DELETE CASCADE;
ALTER TABLE mind_map_nodes
    DROP CONSTRAINT mind_map_nodes_room_id_fkey,
    DROP CONSTRAINT mind_map_nodes_parent_node_id_fkey,
    ADD CONSTRAINT mind_map_nodes_room_id_fkey
        FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE CASCADE,
    ADD CONSTRAINT mind_map_nodes_parent_node_id_fkey
        FOREIGN KEY (parent_node_id) REFERENCES mind_map_nodes(id) ON DELETE SET NULL;
ALTER TABLE participant_node_states
    DROP CONSTRAINT participant_node_states_node_id_fkey,
    DROP CONSTRAINT participant_node_states_participant_id_fkey,
    ADD CONSTRAINT participant_node_states_node_id_fkey
        FOREIGN KEY (node_id) REFERENCES mind_map_nodes(id) ON DELETE CASCADE,
    ADD CONSTRAINT participant_node_states_participant_id_fkey
        FOREIGN KEY (participant_id) REFERENCES participants(id) ON DELETE CASCADE;
ALTER TABLE mediation_sessions
    DROP CONSTRAINT mediation_sessions_room_id_fkey,
    DROP CONSTRAINT mediation_sessions_node_id_fkey,
    ADD CONSTRAINT mediation_sessions_room_id_fkey
        FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE CASCADE,
    ADD CONSTRAINT mediation_sessions_node_id_fkey
        FOREIGN KEY (node_id) REFERENCES mind_map_nodes(id) ON DELETE CASCADE;
ALTER TABLE private_messages
    DROP CONSTRAINT private_messages_mediation_session_id_fkey,
    DROP CONSTRAINT private_messages_participant_id_fkey,
    ADD CONSTRAINT private_messages_mediation_session_id_fkey
        FOREIGN KEY (mediation_session_id) REFERENCES mediation_sessions(id) ON DELETE CASCADE,
    ADD CONSTRAINT private_messages_participant_id_fkey
        FOREIGN KEY (participant_id) REFERENCES participants(id) ON DELETE CASCADE;

-- Room identity, versioning, media time, and discoverable mediation state.
ALTER TABLE rooms
    ADD COLUMN created_by uuid,
    ADD COLUMN media_epoch_at timestamptz,
    ADD COLUMN map_version integer NOT NULL DEFAULT 0 CHECK (map_version >= 0),
    ADD COLUMN room_version bigint NOT NULL DEFAULT 0 CHECK (room_version >= 0),
    ADD COLUMN active_mediation_session_id uuid,
    ADD COLUMN active_mediation_node_id uuid,
    ADD CONSTRAINT rooms_created_by_required
        CHECK (created_by IS NOT NULL) NOT VALID,
    ADD CONSTRAINT rooms_active_mediation_pair
        CHECK ((active_mediation_session_id IS NULL) = (active_mediation_node_id IS NULL));

-- Anonymous Supabase auth subjects bind to exactly one participant per room.
ALTER TABLE participants
    ADD COLUMN auth_user_id uuid,
    ADD COLUMN transcription_consent boolean NOT NULL DEFAULT false,
    ADD COLUMN visual_affect_consent boolean NOT NULL DEFAULT false
        CHECK (visual_affect_consent = false),
    ADD COLUMN structured_sharing_consent boolean NOT NULL DEFAULT false,
    ADD COLUMN consent_revision integer NOT NULL DEFAULT 1 CHECK (consent_revision >= 1),
    ADD COLUMN consent_notice_version text NOT NULL DEFAULT 'cm-privacy-v1',
    ADD COLUMN media_isolated boolean NOT NULL DEFAULT false,
    ADD COLUMN media_token_not_before timestamptz,
    ADD CONSTRAINT participants_auth_user_required
        CHECK (auth_user_id IS NOT NULL) NOT VALID;

CREATE UNIQUE INDEX participants_room_auth_user_uidx
    ON participants (room_id, auth_user_id) WHERE auth_user_id IS NOT NULL;
CREATE UNIQUE INDEX participants_room_livekit_identity_uidx
    ON participants (room_id, livekit_identity) WHERE livekit_identity IS NOT NULL;

-- Browser-final transcript revisions and analysis consumption state.
ALTER TABLE transcript_segments
    ADD COLUMN revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
    ADD COLUMN stream_id uuid,
    ADD COLUMN source_track_sid text,
    ADD COLUMN language text,
    ADD COLUMN confidence double precision CHECK (confidence BETWEEN 0 AND 1),
    ADD COLUMN consent_revision integer NOT NULL DEFAULT 1 CHECK (consent_revision >= 1),
    ADD COLUMN received_at timestamptz NOT NULL DEFAULT now(),
    ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now(),
    ADD COLUMN processed_analysis_id uuid,
    ADD COLUMN processed_at timestamptz,
    ADD CONSTRAINT transcript_stream_required
        CHECK (stream_id IS NOT NULL) NOT VALID,
    ADD CONSTRAINT transcript_track_required
        CHECK (source_track_sid IS NOT NULL) NOT VALID;

CREATE INDEX transcript_segments_room_pending_idx
    ON transcript_segments (room_id, created_at, id)
    WHERE is_final AND processed_at IS NULL;

-- Full mediation state machine, summary versions, and shared consensus tree.
ALTER TABLE mediation_sessions
    DROP CONSTRAINT mediation_sessions_status_check,
    ALTER COLUMN status SET DEFAULT 'proposed',
    ALTER COLUMN started_at DROP NOT NULL,
    ALTER COLUMN started_at DROP DEFAULT,
    ADD CONSTRAINT mediation_sessions_status_check
        CHECK (status IN ('proposed', 'starting', 'active', 'completed', 'cancelled')),
    ADD COLUMN created_at timestamptz NOT NULL DEFAULT now(),
    ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now(),
    ADD COLUMN expires_at timestamptz,
    ADD COLUMN summary_version integer NOT NULL DEFAULT 0 CHECK (summary_version >= 0),
    ADD COLUMN consensus_tree jsonb,
    ADD COLUMN consensus_tree_version integer NOT NULL DEFAULT 0
        CHECK (consensus_tree_version >= 0),
    ADD COLUMN consensus_tree_generated_at timestamptz,
    ADD COLUMN transition_error text,
    ADD CONSTRAINT mediation_consensus_tree_object
        CHECK (consensus_tree IS NULL OR jsonb_typeof(consensus_tree) = 'object'),
    ADD CONSTRAINT mediation_consensus_tree_version_consistent
        CHECK ((consensus_tree IS NULL AND consensus_tree_version = 0)
            OR (consensus_tree IS NOT NULL AND consensus_tree_version >= 1));

CREATE UNIQUE INDEX mediation_sessions_one_open_per_room_uidx
    ON mediation_sessions (room_id)
    WHERE status IN ('proposed', 'starting', 'active');

CREATE TABLE mediation_members (
    mediation_session_id uuid NOT NULL REFERENCES mediation_sessions(id) ON DELETE CASCADE,
    participant_id uuid NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
    entry_decision text NOT NULL DEFAULT 'pending'
        CHECK (entry_decision IN ('pending', 'accept', 'decline')),
    resume_decision text NOT NULL DEFAULT 'pending'
        CHECK (resume_decision IN ('pending', 'accept', 'wait')),
    accepted_summary_version integer CHECK (accepted_summary_version >= 1),
    isolated_at timestamptz,
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (mediation_session_id, participant_id)
);

CREATE INDEX mediation_members_participant_idx
    ON mediation_members (participant_id, mediation_session_id);

ALTER TABLE rooms
    ADD CONSTRAINT rooms_active_mediation_session_fkey
        FOREIGN KEY (active_mediation_session_id) REFERENCES mediation_sessions(id)
        ON DELETE SET NULL DEFERRABLE INITIALLY DEFERRED,
    ADD CONSTRAINT rooms_active_mediation_node_fkey
        FOREIGN KEY (active_mediation_node_id) REFERENCES mind_map_nodes(id)
        ON DELETE SET NULL DEFERRABLE INITIALLY DEFERRED;

-- Evidence makes the automatic 0.72 / two-speaker / three-final-segment rule
-- auditable rather than trusting counts supplied by the model.
CREATE TABLE node_transcript_evidence (
    node_id uuid NOT NULL REFERENCES mind_map_nodes(id) ON DELETE CASCADE,
    transcript_segment_id uuid NOT NULL REFERENCES transcript_segments(id) ON DELETE CASCADE,
    analysis_id uuid NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (node_id, transcript_segment_id)
);

-- Private messages recover across refresh but are inaccessible after exactly 24h.
ALTER TABLE private_messages
    ADD COLUMN client_message_id uuid,
    ADD COLUMN reply_to_message_id uuid REFERENCES private_messages(id) ON DELETE SET NULL,
    ADD COLUMN reply_status text NOT NULL DEFAULT 'completed'
        CHECK (reply_status IN ('pending', 'completed', 'failed')),
    ADD COLUMN expires_at timestamptz;

UPDATE private_messages SET expires_at = created_at + interval '24 hours';

ALTER TABLE private_messages
    ALTER COLUMN expires_at SET NOT NULL,
    ALTER COLUMN expires_at SET DEFAULT (now() + interval '24 hours'),
    ADD CONSTRAINT private_messages_expire_at_24h
        CHECK (expires_at = created_at + interval '24 hours');

CREATE UNIQUE INDEX private_messages_client_message_uidx
    ON private_messages (mediation_session_id, participant_id, client_message_id)
    WHERE client_message_id IS NOT NULL AND role = 'user';
CREATE INDEX private_messages_expiry_idx ON private_messages (expires_at);

-- Command idempotency, Worker execution leases, analysis receipts, isolation
-- results, and verified webhook receipts.
CREATE TABLE idempotency_records (
    auth_user_id uuid NOT NULL,
    method text NOT NULL,
    path text NOT NULL,
    idempotency_key uuid NOT NULL,
    request_hash text NOT NULL,
    response_status integer,
    response_body jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL DEFAULT (now() + interval '24 hours'),
    PRIMARY KEY (auth_user_id, method, path, idempotency_key)
);

CREATE TABLE worker_leases (
    room_id uuid PRIMARY KEY REFERENCES rooms(id) ON DELETE CASCADE,
    run_id uuid NOT NULL,
    status text NOT NULL CHECK (status IN ('starting', 'ready', 'degraded', 'stopped')),
    audio_status text NOT NULL CHECK (audio_status IN ('disabled', 'starting', 'ready', 'error')),
    video_status text NOT NULL DEFAULT 'disabled' CHECK (video_status = 'disabled'),
    meeting_agent_status text NOT NULL
        CHECK (meeting_agent_status IN ('disabled', 'starting', 'ready', 'error')),
    lease_expires_at timestamptz NOT NULL,
    last_heartbeat_at timestamptz NOT NULL DEFAULT now(),
    media_cleanup_targets jsonb NOT NULL DEFAULT '[]'::jsonb
        CHECK (jsonb_typeof(media_cleanup_targets) = 'array'),
    delete_media_room boolean NOT NULL DEFAULT false,
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX worker_leases_run_uidx ON worker_leases (run_id);

CREATE TABLE analysis_receipts (
    room_id uuid NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    analysis_id uuid NOT NULL,
    base_map_version integer NOT NULL CHECK (base_map_version >= 0),
    result_map_version integer NOT NULL CHECK (result_map_version >= 0),
    response_body jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (room_id, analysis_id)
);

CREATE TABLE media_isolation_results (
    mediation_session_id uuid NOT NULL REFERENCES mediation_sessions(id) ON DELETE CASCADE,
    participant_id uuid NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
    run_id uuid NOT NULL,
    succeeded boolean NOT NULL,
    safe_error_code text,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (mediation_session_id, participant_id)
);

CREATE TABLE livekit_webhook_receipts (
    event_id text PRIMARY KEY,
    event_type text NOT NULL,
    room_name text,
    received_at timestamptz NOT NULL DEFAULT now()
);

-- Realtime carries privacy-safe invalidation events, never private chat or full
-- participant state. Authorized clients refetch the business APIs.
CREATE TABLE room_events (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    room_id uuid NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    room_version bigint NOT NULL CHECK (room_version >= 0),
    event_type text NOT NULL CHECK (event_type IN (
        'room.changed',
        'room.mediation.changed',
        'mediation.consensus-tree.changed'
    )),
    mediation_session_id uuid REFERENCES mediation_sessions(id) ON DELETE CASCADE,
    payload jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(payload) = 'object'),
    occurred_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX room_events_room_version_idx
    ON room_events (room_id, room_version, occurred_at);

-- Timestamp/version triggers.
CREATE TRIGGER transcript_segments_set_updated_at BEFORE UPDATE ON transcript_segments
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER mediation_sessions_set_updated_at BEFORE UPDATE ON mediation_sessions
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER mediation_members_set_updated_at BEFORE UPDATE ON mediation_members
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER worker_leases_set_updated_at BEFORE UPDATE ON worker_leases
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE FUNCTION bump_room_version() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    NEW.room_version = OLD.room_version + 1;
    RETURN NEW;
END;
$$;

CREATE TRIGGER rooms_bump_room_version BEFORE UPDATE ON rooms
    FOR EACH ROW EXECUTE FUNCTION bump_room_version();

-- Supabase-compatible auth helpers without requiring the auth schema in plain
-- local PostgreSQL. PostgREST supplies request.jwt.claim.sub for authenticated
-- and anonymous-auth sessions.
CREATE FUNCTION requesting_auth_user_id() RETURNS uuid
LANGUAGE sql STABLE
AS $$
    SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
$$;

CREATE FUNCTION is_room_member(target_room_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
SET row_security = off
AS $$
    SELECT EXISTS (
        SELECT 1
        FROM participants p
        WHERE p.room_id = target_room_id
          AND p.auth_user_id = requesting_auth_user_id()
    )
$$;

-- Browser roles receive read-only access to safe shared tables. All mutations
-- still go through authenticated Next.js services using the server credential.
ALTER TABLE rooms ENABLE ROW LEVEL SECURITY;
ALTER TABLE participants ENABLE ROW LEVEL SECURITY;
ALTER TABLE transcript_segments ENABLE ROW LEVEL SECURITY;
ALTER TABLE mind_map_nodes ENABLE ROW LEVEL SECURITY;
ALTER TABLE participant_node_states ENABLE ROW LEVEL SECURITY;
ALTER TABLE mediation_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE mediation_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE private_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE node_transcript_evidence ENABLE ROW LEVEL SECURITY;
ALTER TABLE idempotency_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE worker_leases ENABLE ROW LEVEL SECURITY;
ALTER TABLE analysis_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE media_isolation_results ENABLE ROW LEVEL SECURITY;
ALTER TABLE livekit_webhook_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE room_events ENABLE ROW LEVEL SECURITY;

ALTER TABLE rooms FORCE ROW LEVEL SECURITY;
ALTER TABLE participants FORCE ROW LEVEL SECURITY;
ALTER TABLE transcript_segments FORCE ROW LEVEL SECURITY;
ALTER TABLE mind_map_nodes FORCE ROW LEVEL SECURITY;
ALTER TABLE participant_node_states FORCE ROW LEVEL SECURITY;
ALTER TABLE mediation_sessions FORCE ROW LEVEL SECURITY;
ALTER TABLE mediation_members FORCE ROW LEVEL SECURITY;
ALTER TABLE private_messages FORCE ROW LEVEL SECURITY;
ALTER TABLE node_transcript_evidence FORCE ROW LEVEL SECURITY;
ALTER TABLE idempotency_records FORCE ROW LEVEL SECURITY;
ALTER TABLE worker_leases FORCE ROW LEVEL SECURITY;
ALTER TABLE analysis_receipts FORCE ROW LEVEL SECURITY;
ALTER TABLE media_isolation_results FORCE ROW LEVEL SECURITY;
ALTER TABLE livekit_webhook_receipts FORCE ROW LEVEL SECURITY;
ALTER TABLE room_events FORCE ROW LEVEL SECURITY;

CREATE POLICY rooms_member_select ON rooms FOR SELECT
    USING (created_by = requesting_auth_user_id() OR is_room_member(id));
CREATE POLICY participants_member_select ON participants FOR SELECT
    USING (is_room_member(room_id));
CREATE POLICY transcripts_member_select ON transcript_segments FOR SELECT
    USING (is_room_member(room_id));
CREATE POLICY mind_map_nodes_member_select ON mind_map_nodes FOR SELECT
    USING (is_room_member(room_id));
CREATE POLICY mediation_members_self_select ON mediation_members FOR SELECT
    USING (EXISTS (
        SELECT 1 FROM participants p
        WHERE p.id = participant_id
          AND p.auth_user_id = requesting_auth_user_id()
    ));
CREATE POLICY private_messages_owner_select ON private_messages FOR SELECT
    USING (
        expires_at > now()
        AND EXISTS (
            SELECT 1 FROM participants p
            WHERE p.id = participant_id
              AND p.auth_user_id = requesting_auth_user_id()
        )
    );
CREATE POLICY room_events_member_select ON room_events FOR SELECT
    USING (is_room_member(room_id));

-- Physical cleanup complements the RLS expiry cutoff. A scheduler will call this
-- function later; defining it locally does not configure a shared cron job.
CREATE FUNCTION cleanup_expired_private_messages() RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
SET row_security = off
AS $$
DECLARE
    deleted_count bigint;
BEGIN
    DELETE FROM private_messages WHERE expires_at <= now();
    GET DIAGNOSTICS deleted_count = ROW_COUNT;
    RETURN deleted_count;
END;
$$;

REVOKE ALL ON FUNCTION cleanup_expired_private_messages() FROM PUBLIC;

-- Apply Supabase role grants only when those roles exist.
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
        GRANT SELECT ON rooms, participants, transcript_segments, mind_map_nodes,
            mediation_members, private_messages, room_events TO authenticated;
        GRANT EXECUTE ON FUNCTION requesting_auth_user_id(), is_room_member(uuid)
            TO authenticated;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
        GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role;
        GRANT EXECUTE ON FUNCTION cleanup_expired_private_messages() TO service_role;
    END IF;
END
$$;

-- Add only the safe invalidation table to Supabase Realtime when that
-- publication exists. This is inert on the plain local PostgreSQL container.
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime')
       AND NOT EXISTS (
           SELECT 1 FROM pg_publication_tables
           WHERE pubname = 'supabase_realtime'
             AND schemaname = 'public'
             AND tablename = 'room_events'
       ) THEN
        ALTER PUBLICATION supabase_realtime ADD TABLE room_events;
    END IF;
END
$$;

COMMIT;
