import { requireAuthenticatedUser } from "@/lib/server/auth.ts";
import { routeResponse, successResponse } from "@/lib/server/http.ts";
import { idempotentCommand } from "@/lib/server/route-helpers.ts";
import { parseJsonBody, parseUuid } from "@/lib/server/validation.ts";
import { proposeMediationRequestSchema } from "@/contracts/mediation";
import { proposeMediation, resolveMediation } from "@/services/mediation";

type Context = { params: Promise<{ roomId: string; nodeId: string }> };
export async function GET(request: Request, context: Context): Promise<Response> {
  return routeResponse(async (requestId) => {
    const user = await requireAuthenticatedUser(request);
    const params = await context.params;
    const roomId = parseUuid(params.roomId, "roomId");
    const nodeId = parseUuid(params.nodeId, "nodeId");
    return successResponse(await resolveMediation(roomId, nodeId, user.id), { requestId });
  });
}

export async function POST(request: Request, context: Context): Promise<Response> {
  return routeResponse(async (requestId) => {
    const user = await requireAuthenticatedUser(request);
    const params = await context.params;
    const roomId = parseUuid(params.roomId, "roomId");
    const nodeId = parseUuid(params.nodeId, "nodeId");
    const body = await parseJsonBody(request, proposeMediationRequestSchema);
    return idempotentCommand(request, requestId, user.id, body, 201, (db) => proposeMediation(db, roomId, nodeId, user.id, body.participantIds, body.reason));
  });
}
