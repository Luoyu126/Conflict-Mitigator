import { createRoomRequestSchema } from "@/contracts/rooms";
import { requireAuthenticatedUser } from "@/lib/server/auth.ts";
import { routeResponse } from "@/lib/server/http.ts";
import { idempotentCommand } from "@/lib/server/route-helpers.ts";
import { parseJsonBody } from "@/lib/server/validation.ts";
import { createRoom } from "@/services/rooms";

export async function POST(request: Request): Promise<Response> {
  return routeResponse(async (requestId) => {
    const user = await requireAuthenticatedUser(request);
    const body = await parseJsonBody(request, createRoomRequestSchema);
    return idempotentCommand(request, requestId, user.id, body, 201, (db) => createRoom(db, user.id, body.title));
  });
}
