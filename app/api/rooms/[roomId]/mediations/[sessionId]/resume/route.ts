import { resumeRequestSchema } from "@/contracts/mediation";
import { requireAuthenticatedUser } from "@/lib/server/auth.ts";
import { routeResponse } from "@/lib/server/http.ts";
import { idempotentCommand } from "@/lib/server/route-helpers.ts";
import { parseJsonBody, parseUuid } from "@/lib/server/validation.ts";
import { recordResumeDecision } from "@/services/mediation";

type Context = { params: Promise<{ roomId: string; sessionId: string }> };
export async function POST(request: Request, context: Context): Promise<Response> {
  return routeResponse(async (requestId) => {
    const user = await requireAuthenticatedUser(request);
    const params = await context.params;
    const roomId = parseUuid(params.roomId, "roomId");
    const sessionId = parseUuid(params.sessionId, "sessionId");
    const body = await parseJsonBody(request, resumeRequestSchema);
    return idempotentCommand(request, requestId, user.id, body, 200, (db) => recordResumeDecision(db, roomId, sessionId, user.id, body.decision, body.summaryVersion));
  });
}
