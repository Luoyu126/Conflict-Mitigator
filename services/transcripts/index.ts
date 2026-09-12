import "server-only";
import { z } from "zod";
import type { TranscriptPage, TranscriptSegment } from "../../contracts/rooms";
import { getDatabase } from "../../lib/db/postgres.ts";
import { requireRoomMember } from "../../lib/db/repositories/membership.ts";
import { ApiProblem } from "../../lib/server/errors.ts";

type TranscriptRow = Omit<TranscriptSegment, "createdAt" | "updatedAt"> & { createdAt: Date; updatedAt: Date };
const cursorSchema = z.object({ createdAt: z.string().datetime(), id: z.string().uuid() }).strict();
type Cursor = z.infer<typeof cursorSchema>;
function decodeCursor(value: string): Cursor {
  try {
    const parsed = cursorSchema.safeParse(JSON.parse(Buffer.from(value, "base64url").toString("utf8")));
    if (parsed.success) return parsed.data;
  } catch { /* normalized below */ }
  throw new ApiProblem({ status: 422, code: "VALIDATION_ERROR", message: "The transcript cursor is invalid.", issues: [{ path: "before", reason: "Must be a cursor returned by this API." }] });
}
function encodeCursor(row: TranscriptRow): string {
  return Buffer.from(JSON.stringify({ createdAt: row.createdAt.toISOString(), id: row.id })).toString("base64url");
}
export async function listTranscripts(roomId: string, authUserId: string, options: { limit: number; before?: string }): Promise<TranscriptPage> {
  const db = getDatabase();
  await requireRoomMember(db, roomId, authUserId);
  const cursor = options.before ? decodeCursor(options.before) : null;
  const rows = await db<TranscriptRow[]>`
    SELECT id, room_id AS "roomId", participant_id AS "participantId", content,
      started_at_ms::double precision AS "startedAtMs", ended_at_ms::double precision AS "endedAtMs",
      is_final AS "isFinal", revision, stream_id::text AS "streamId", source_track_sid AS "sourceTrackSid",
      language, confidence, created_at AS "createdAt", updated_at AS "updatedAt"
    FROM transcript_segments WHERE room_id = ${roomId}::uuid
      AND (${cursor?.createdAt ?? null}::timestamptz IS NULL OR (created_at, id) < (${cursor?.createdAt ?? null}::timestamptz, ${cursor?.id ?? null}::uuid))
    ORDER BY created_at DESC, id DESC LIMIT ${options.limit + 1}`;
  const hasMore = rows.length > options.limit;
  const selected = rows.slice(0, options.limit);
  const oldest = selected.at(-1);
  return {
    items: selected.reverse().map((row) => ({ ...row, createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString() })),
    pageInfo: { hasMore, nextBeforeCursor: hasMore && oldest ? encodeCursor(oldest) : null },
  };
}
