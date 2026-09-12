import { requireAuthenticatedUser } from "@/lib/server/auth.ts";
import { routeResponse, successResponse } from "@/lib/server/http.ts";
import { parseUuid } from "@/lib/server/validation.ts";
import { getNode } from "@/services/mind-map";

type Context = { params: Promise<{ roomId: string; nodeId: string }> };
export async function GET(request: Request, context: Context): Promise<Response> {
  return routeResponse(async (requestId) => {
    const user = await requireAuthenticatedUser(request);
    const params = await context.params;
    const roomId = parseUuid(params.roomId, "roomId");
    const nodeId = parseUuid(params.nodeId, "nodeId");
    return successResponse(await getNode(roomId, nodeId, user.id), { requestId });
  });
}
