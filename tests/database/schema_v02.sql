\set ON_ERROR_STOP on

BEGIN;

CREATE ROLE cm_rls_test NOLOGIN;
GRANT USAGE ON SCHEMA public TO cm_rls_test;
GRANT SELECT ON rooms, participants, transcript_segments, mind_map_nodes,
    mediation_members, private_messages, room_events TO cm_rls_test;
GRANT EXECUTE ON FUNCTION requesting_auth_user_id(), is_room_member(uuid)
    TO cm_rls_test;

INSERT INTO rooms (id, title, created_by)
VALUES (
    '00000000-0000-4000-8000-000000000001',
    'Schema test',
    '00000000-0000-4000-8000-000000000101'
);

INSERT INTO participants (
    id, room_id, auth_user_id, display_name, livekit_identity,
    transcription_consent, structured_sharing_consent
) VALUES
(
    '00000000-0000-4000-8000-000000000011',
    '00000000-0000-4000-8000-000000000001',
    '00000000-0000-4000-8000-000000000101',
    'Alice',
    '00000000-0000-4000-8000-000000000011',
    true,
    true
),
(
    '00000000-0000-4000-8000-000000000012',
    '00000000-0000-4000-8000-000000000001',
    '00000000-0000-4000-8000-000000000102',
    'Bob',
    '00000000-0000-4000-8000-000000000012',
    true,
    true
);

INSERT INTO transcript_segments (
    id, room_id, participant_id, content, is_final, stream_id,
    source_track_sid, consent_revision
) VALUES (
    '00000000-0000-4000-8000-000000000021',
    '00000000-0000-4000-8000-000000000001',
    '00000000-0000-4000-8000-000000000011',
    'A final segment',
    true,
    '00000000-0000-4000-8000-000000000022',
    'TR_audio_test',
    1
);

INSERT INTO mind_map_nodes (id, room_id, topic, contention_score)
VALUES (
    '00000000-0000-4000-8000-000000000031',
    '00000000-0000-4000-8000-000000000001',
    'Test node',
    0.8
);

INSERT INTO mediation_sessions (
    id, room_id, node_id, status, expires_at, consensus_tree,
    consensus_tree_version, consensus_tree_generated_at
) VALUES (
    '00000000-0000-4000-8000-000000000041',
    '00000000-0000-4000-8000-000000000001',
    '00000000-0000-4000-8000-000000000031',
    'active',
    now() + interval '2 minutes',
    '{"version":1,"nodes":[],"edges":[]}'::jsonb,
    1,
    now()
);

UPDATE rooms SET
    status = 'mediation',
    active_mediation_session_id = '00000000-0000-4000-8000-000000000041',
    active_mediation_node_id = '00000000-0000-4000-8000-000000000031'
WHERE id = '00000000-0000-4000-8000-000000000001';

INSERT INTO mediation_members (mediation_session_id, participant_id, entry_decision)
VALUES
(
    '00000000-0000-4000-8000-000000000041',
    '00000000-0000-4000-8000-000000000011',
    'accept'
),
(
    '00000000-0000-4000-8000-000000000041',
    '00000000-0000-4000-8000-000000000012',
    'accept'
);

INSERT INTO private_messages (
    id, mediation_session_id, participant_id, role, content,
    client_message_id, reply_status, created_at, expires_at
) VALUES
(
    '00000000-0000-4000-8000-000000000051',
    '00000000-0000-4000-8000-000000000041',
    '00000000-0000-4000-8000-000000000011',
    'user',
    'Alice private message',
    '00000000-0000-4000-8000-000000000061',
    'completed',
    now(),
    now() + interval '24 hours'
),
(
    '00000000-0000-4000-8000-000000000052',
    '00000000-0000-4000-8000-000000000041',
    '00000000-0000-4000-8000-000000000012',
    'user',
    'Bob private message',
    '00000000-0000-4000-8000-000000000062',
    'completed',
    now(),
    now() + interval '24 hours'
),
(
    '00000000-0000-4000-8000-000000000053',
    '00000000-0000-4000-8000-000000000041',
    '00000000-0000-4000-8000-000000000011',
    'user',
    'Expired private message',
    '00000000-0000-4000-8000-000000000063',
    'completed',
    now() - interval '25 hours',
    now() - interval '1 hour'
);

DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM private_messages
        WHERE expires_at <> created_at + interval '24 hours'
    ) THEN
        RAISE EXCEPTION 'private message expiry is not exactly 24 hours';
    END IF;
    IF has_table_privilege('cm_rls_test', 'participant_node_states', 'SELECT') THEN
        RAISE EXCEPTION 'private participant state was granted to browser role';
    END IF;
END
$$;

SELECT set_config(
    'request.jwt.claim.sub',
    '00000000-0000-4000-8000-000000000101',
    true
);
SET LOCAL ROLE cm_rls_test;

DO $$
BEGIN
    IF (SELECT count(*) FROM rooms) <> 1 THEN
        RAISE EXCEPTION 'room member RLS failed';
    END IF;
    IF (SELECT count(*) FROM participants) <> 2 THEN
        RAISE EXCEPTION 'participant room projection RLS failed';
    END IF;
    IF (SELECT count(*) FROM private_messages) <> 1 THEN
        RAISE EXCEPTION 'private message owner or expiry RLS failed';
    END IF;
END
$$;

RESET ROLE;

DO $$
BEGIN
    IF cleanup_expired_private_messages() <> 1 THEN
        RAISE EXCEPTION 'expired message cleanup failed';
    END IF;
END
$$;

DELETE FROM rooms WHERE id = '00000000-0000-4000-8000-000000000001';

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM participants)
       OR EXISTS (SELECT 1 FROM mediation_sessions)
       OR EXISTS (SELECT 1 FROM private_messages) THEN
        RAISE EXCEPTION 'room cascade cleanup failed';
    END IF;
END
$$;

ROLLBACK;
