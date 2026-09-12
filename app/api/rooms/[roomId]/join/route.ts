import { joinRequestSchema } from "@/contracts/rooms";
import { requireAuthenticatedUser } from "@/lib/server/auth.ts";
import { routeResponse, successResponse } from "@/lib/server/http.ts";
import { idempotentCommand } from "@/lib/server/route-helpers.ts";
import { parseJsonBody, parseUuid } from "@/lib/server/validation.ts";
import { joinRoom, getRoomState, renewLiveKitToken } from "@/services/rooms";

type Context = { params: Promise<{ roomId: string }> };
export async function POST(request: Request, context: Context): Promise<Response> {
  return routeResponse(async (requestId) => {
    const user = await requireAuthenticatedUser(request);
    const roomId = parseUuid((await context.params).roomId, "roomId");
    const body = await parseJsonBody(request, joinRequestSchema);
    const response = await idempotentCommand(request, requestId, user.id, body, 200, (db) => joinRoom(db, roomId, user.id, body));
    // An old successful Join must never replay a revoked media credential after
    // leave/isolation. Reauthorize and issue a current token for safe retries.
    if (response.headers.get("Idempotency-Replayed") === "true") {
      const { livekit } = await renewLiveKitToken(roomId, user.id);
      const { room, me } = await getRoomState(roomId, user.id);
      return successResponse({ room, me, livekit, navigationPath: `/room/${roomId}` }, { requestId,
        headers: { "Idempotency-Replayed": "true" } });
    }
    return response;
  });
}
