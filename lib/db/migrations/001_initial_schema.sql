-- Based on docs/database_schema.md (MVP v0.1).
-- Apply once to an empty application database with psql -v ON_ERROR_STOP=1.
BEGIN;

CREATE TABLE rooms (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    title text NOT NULL,
    status text NOT NULL DEFAULT 'lobby'
        CHECK (status IN ('lobby', 'meeting', 'mediation', 'ended')),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE participants (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    room_id uuid NOT NULL REFERENCES rooms(id),
    display_name text NOT NULL,
    role text NOT NULL DEFAULT 'participant' CHECK (role IN ('host', 'participant')),
    status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'left')),
    livekit_identity text,
    joined_at timestamptz NOT NULL DEFAULT now(),
    left_at timestamptz
);

CREATE TABLE transcript_segments (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    room_id uuid NOT NULL REFERENCES rooms(id),
    participant_id uuid NOT NULL REFERENCES participants(id),
    content text NOT NULL,
    started_at_ms bigint CHECK (started_at_ms >= 0),
    ended_at_ms bigint CHECK (ended_at_ms >= 0),
    is_final boolean NOT NULL DEFAULT false,
    created_at timestamptz NOT NULL DEFAULT now(),
    CHECK (ended_at_ms >= started_at_ms)
);

CREATE TABLE mind_map_nodes (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    room_id uuid NOT NULL REFERENCES rooms(id),
    parent_node_id uuid REFERENCES mind_map_nodes(id),
    topic text NOT NULL,
    summary text,
    status text NOT NULL DEFAULT 'normal'
        CHECK (status IN ('normal', 'heated', 'private_mediation', 'ready_to_resume')),
    contention_score double precision NOT NULL DEFAULT 0
        CHECK (contention_score BETWEEN 0 AND 1),
    readiness_score double precision CHECK (readiness_score BETWEEN 0 AND 1),
    discussion_loop_count integer NOT NULL DEFAULT 0 CHECK (discussion_loop_count >= 0),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CHECK (parent_node_id <> id)
);

CREATE TABLE participant_node_states (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    node_id uuid NOT NULL REFERENCES mind_map_nodes(id),
    participant_id uuid NOT NULL REFERENCES participants(id),
    position text,
    supporting_reasons jsonb NOT NULL DEFAULT '[]'::jsonb
        CHECK (jsonb_typeof(supporting_reasons) = 'array'),
    underlying_concerns jsonb NOT NULL DEFAULT '[]'::jsonb
        CHECK (jsonb_typeof(underlying_concerns) = 'array'),
    emotion_intensity double precision CHECK (emotion_intensity BETWEEN 0 AND 1),
    view_of_others jsonb NOT NULL DEFAULT '[]'::jsonb
        CHECK (jsonb_typeof(view_of_others) = 'array'),
    acceptable_compromises jsonb NOT NULL DEFAULT '[]'::jsonb
        CHECK (jsonb_typeof(acceptable_compromises) = 'array'),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (node_id, participant_id)
);

CREATE TABLE mediation_sessions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    room_id uuid NOT NULL REFERENCES rooms(id),
    node_id uuid NOT NULL REFERENCES mind_map_nodes(id),
    status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'completed')),
    trigger_reason text,
    shared_summary text,
    started_at timestamptz NOT NULL DEFAULT now(),
    ended_at timestamptz
);

CREATE TABLE private_messages (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    mediation_session_id uuid NOT NULL REFERENCES mediation_sessions(id),
    participant_id uuid NOT NULL REFERENCES participants(id),
    role text NOT NULL CHECK (role IN ('user', 'assistant')),
    content text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX participants_room_id_idx ON participants (room_id);
CREATE INDEX transcript_segments_room_created_idx ON transcript_segments (room_id, created_at);
CREATE INDEX transcript_segments_participant_id_idx ON transcript_segments (participant_id);
CREATE INDEX mind_map_nodes_room_id_idx ON mind_map_nodes (room_id);
CREATE INDEX mind_map_nodes_parent_node_id_idx ON mind_map_nodes (parent_node_id);
CREATE INDEX participant_node_states_participant_id_idx ON participant_node_states (participant_id);
CREATE INDEX mediation_sessions_room_id_idx ON mediation_sessions (room_id);
CREATE INDEX mediation_sessions_node_started_idx ON mediation_sessions (node_id, started_at);
CREATE INDEX private_messages_session_participant_created_idx
    ON private_messages (mediation_session_id, participant_id, created_at);
CREATE INDEX private_messages_participant_id_idx ON private_messages (participant_id);

CREATE FUNCTION set_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    NEW.updated_at = clock_timestamp();
    RETURN NEW;
END;
$$;

CREATE TRIGGER rooms_set_updated_at BEFORE UPDATE ON rooms
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER mind_map_nodes_set_updated_at BEFORE UPDATE ON mind_map_nodes
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER participant_node_states_set_updated_at BEFORE UPDATE ON participant_node_states
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Default-deny for non-owner roles until authenticated participant policies exist.
-- Owners/superusers bypass RLS: application authorization is still required.
ALTER TABLE private_messages ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON private_messages FROM PUBLIC;

COMMIT;
