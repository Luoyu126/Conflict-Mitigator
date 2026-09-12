import { emptyBodySchema } from "@/contracts/rooms";
import { requireAuthenticatedUser } from "@/lib/server/auth.ts";
import { routeResponse, successResponse } from "@/lib/server/http.ts";
import { parseJsonBody, parseUuid } from "@/lib/server/validation.ts";
import { renewLiveKitToken } from "@/services/rooms";

type Context = { params: Promise<{ roomId: string }> };
export async function POST(request: Request, context: Context): Promise<Response> {
  return routeResponse(async (requestId) => {
    const user = await requireAuthenticatedUser(request);
    const roomId = parseUuid((await context.params).roomId, "roomId");
    await parseJsonBody(request, emptyBodySchema);
    return successResponse(await renewLiveKitToken(roomId, user.id), { requestId });
  });
}
