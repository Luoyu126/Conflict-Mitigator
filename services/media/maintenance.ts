import "server-only";
import { getDatabase, withTransaction } from "../../lib/db/postgres.ts";
import { emitRoomEvent } from "../../lib/db/repositories/room-events.ts";

/** Invoked by the long-lived Worker supervisor, never untracked request work. */
export async function runMaintenance(): Promise<void> {
  const db = getDatabase();
  const expired = await db<{ room_id: string }[]>`SELECT DISTINCT room_id FROM mediation_sessions
    WHERE (status='proposed' AND expires_at<=clock_timestamp())
      OR (status='starting' AND updated_at<clock_timestamp()-interval '30 seconds')`;
  for (const { room_id: roomId } of expired) await withTransaction(async tx => {
    await tx`SELECT id FROM rooms WHERE id=${roomId}::uuid FOR UPDATE`;
    const sessions = await tx<{ id: string; node_id: string; status: string }[]>`SELECT id,node_id,status
      FROM mediation_sessions WHERE room_id=${roomId}::uuid
      AND ((status='proposed' AND expires_at<=clock_timestamp()) OR
        (status='starting' AND updated_at<clock_timestamp()-interval '30 seconds')) FOR UPDATE`;
    for (const session of sessions) {
      if (session.status === "starting") {
        await tx`UPDATE participants SET media_isolated=true,media_cleanup_pending=true,
          media_token_not_before=GREATEST(media_token_not_before,to_timestamp(ceil(extract(epoch from clock_timestamp()))+1))
          WHERE id IN (SELECT participant_id FROM mediation_members WHERE mediation_session_id=${session.id}::uuid)`;
      }
      await tx`UPDATE mediation_sessions SET status='cancelled',ended_at=clock_timestamp(),
        transition_error=${session.status === "starting" ? "MEDIA_ISOLATION_FAILED" : "PROPOSAL_EXPIRED"} WHERE id=${session.id}::uuid`;
      await tx`UPDATE mind_map_nodes SET status='normal',readiness_score=NULL WHERE id=${session.node_id}::uuid`;
      await tx`UPDATE rooms SET status=CASE WHEN status='ended' THEN 'ended' ELSE 'meeting' END,
        active_mediation_session_id=NULL,active_mediation_node_id=NULL
        WHERE id=${roomId}::uuid AND active_mediation_session_id=${session.id}::uuid`;
      await emitRoomEvent(tx, roomId, "room.mediation.changed", { mediationSessionId: session.id });
    }
  });
  await db`SELECT cleanup_expired_private_messages()`;
  await db`DELETE FROM affect_observations WHERE expires_at<=clock_timestamp()`;
  await db`DELETE FROM idempotency_records WHERE expires_at<=clock_timestamp()`;
  await db`DELETE FROM room_events WHERE occurred_at<clock_timestamp()-interval '24 hours'`;
}
