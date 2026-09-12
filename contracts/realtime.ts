import { z } from "zod";

export const roomEventSchema = z.object({
  id: z.string().uuid(), room_id: z.string().uuid(), room_version: z.number().int().nonnegative(),
  event_type: z.enum(["room.changed", "room.mediation.changed", "mediation.consensus-tree.changed"]),
  mediation_session_id: z.string().uuid().nullable(),
  payload: z.record(z.string(), z.unknown()), occurred_at: z.string(),
});
export type RoomEvent = z.infer<typeof roomEventSchema>;
export type RoomPresence = { participantId: string; onlineAt: string };
