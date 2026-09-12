import "server-only";
import type { DatabaseExecutor } from "../postgres";

export type RoomEventType = "room.changed" | "room.mediation.changed" | "mediation.consensus-tree.changed";

/** Bumps room_version and emits a privacy-safe refetch signal. */
export async function emitRoomEvent(
  db: DatabaseExecutor, roomId: string, eventType: RoomEventType = "room.changed",
  options: { mediationSessionId?: string | null; payload?: Record<string, string | number | boolean | null> } = {},
): Promise<number> {
  const rooms = await db<{ roomVersion: number }[]>`
    UPDATE rooms SET updated_at = clock_timestamp() WHERE id = ${roomId}::uuid
    RETURNING room_version AS "roomVersion"
  `;
  const roomVersion = rooms[0]?.roomVersion;
  if (roomVersion === undefined) throw new Error("Room disappeared while emitting an event.");
  await db`
    INSERT INTO room_events (room_id, room_version, event_type, mediation_session_id, payload)
    VALUES (${roomId}::uuid, ${roomVersion}, ${eventType},
      ${options.mediationSessionId ?? null}::uuid, ${db.json(options.payload ?? {})})
  `;
  return roomVersion;
}
