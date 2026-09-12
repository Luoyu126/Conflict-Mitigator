import { requireAuthenticatedUser } from "@/lib/server/auth.ts";
import { routeResponse, successResponse } from "@/lib/server/http.ts";
import { parseUuid } from "@/lib/server/validation.ts";
import { getMindMap } from "@/services/mind-map";

type Context = { params: Promise<{ roomId: string }> };
export async function GET(request: Request, context: Context): Promise<Response> {
  return routeResponse(async (requestId) => {
    const user = await requireAuthenticatedUser(request);
    const roomId = parseUuid((await context.params).roomId, "roomId");
    return successResponse(await getMindMap(roomId, user.id), { requestId });
  });
}
