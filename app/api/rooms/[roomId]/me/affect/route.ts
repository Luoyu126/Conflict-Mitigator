import { requireAuthenticatedUser } from "@/lib/server/auth.ts";
import { routeResponse, successResponse } from "@/lib/server/http.ts";
import { parseUuid } from "@/lib/server/validation.ts";
import { getMyAffect } from "@/services/affect";

export async function GET(request: Request, context: { params: Promise<{ roomId: string }> }) {
  return routeResponse(async (requestId) => {
    const user = await requireAuthenticatedUser(request);
    const roomId = parseUuid((await context.params).roomId, "roomId");
    return successResponse(await getMyAffect(roomId, user.id), { requestId });
  });
}
