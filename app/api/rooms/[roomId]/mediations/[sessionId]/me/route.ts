import { requireAuthenticatedUser } from "@/lib/server/auth.ts";
import { routeResponse, successResponse } from "@/lib/server/http.ts";
import { parseUuid } from "@/lib/server/validation.ts";
import { getMediationMe } from "@/services/mediation";

type Context = { params: Promise<{ roomId: string; sessionId: string }> };
export async function GET(request: Request, context: Context): Promise<Response> {
  return routeResponse(async (requestId) => {
    const user = await requireAuthenticatedUser(request);
    const params = await context.params;
    const roomId = parseUuid(params.roomId, "roomId");
    const sessionId = parseUuid(params.sessionId, "sessionId");
    return successResponse(await getMediationMe(roomId, sessionId, user.id), { requestId });
  });
}
