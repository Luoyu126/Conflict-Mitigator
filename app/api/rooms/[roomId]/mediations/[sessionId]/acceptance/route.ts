import { entryDecisionRequestSchema } from "@/contracts/mediation";
import { requireAuthenticatedUser } from "@/lib/server/auth.ts";
import { routeResponse, successResponse, errorResponse } from "@/lib/server/http.ts";
import { runIdempotent, type JsonValue } from "@/lib/server/idempotency.ts";
import { ApiProblem } from "@/lib/server/errors.ts";
import { parseJsonBody, parseUuid, requireIdempotencyKey } from "@/lib/server/validation.ts";
import { recordEntryDecision } from "@/services/mediation";

type Context = { params: Promise<{ roomId: string; sessionId: string }> };
export async function POST(request: Request, context: Context): Promise<Response> {
  return routeResponse(async (requestId) => {
    const user = await requireAuthenticatedUser(request);
    const params = await context.params;
    const roomId = parseUuid(params.roomId, "roomId");
    const sessionId = parseUuid(params.sessionId, "sessionId");
    const body = await parseJsonBody(request, entryDecisionRequestSchema);
    const result = await runIdempotent({ authUserId: user.id, method: request.method,
      path: new URL(request.url).pathname, idempotencyKey: requireIdempotencyKey(request), body,
    }, async db => {
      const decision = await recordEntryDecision(db, roomId, sessionId, user.id, body.decision);
      if (decision.expired) {
        const response = errorResponse(new ApiProblem({ status: 409, code: "PROPOSAL_EXPIRED", message: "The mediation proposal expired." }), requestId);
        return { status: 409, body: await response.json() as JsonValue };
      }
      return { status: decision.triggeredStarting ? 202 : 200, body: decision.session as unknown as JsonValue };
    });
    const headers = result.replayed ? { "Idempotency-Replayed": "true" } : undefined;
    if (result.status === 409) return Response.json({ ...(result.body as object), requestId }, {
      status: 409, headers: { "Cache-Control": "no-store", ...headers },
    });
    return successResponse(result.body, { status: result.status, requestId, headers });
  });
}
