import { z } from "zod";
import { sendMessageRequestSchema } from "@/contracts/mediation";
import { requireAuthenticatedUser } from "@/lib/server/auth.ts";
import { ApiProblem } from "@/lib/server/errors.ts";
import { routeResponse, successResponse } from "@/lib/server/http.ts";
import { parseJsonBody, parseUuid } from "@/lib/server/validation.ts";
import { listPrivateMessages, sendPrivateMessage } from "@/services/mediation";

type Context = { params: Promise<{ roomId: string; sessionId: string }> };
const limitSchema = z.coerce.number().int().min(1).max(200).default(100);

export async function GET(request: Request, context: Context): Promise<Response> {
  return routeResponse(async (requestId) => {
    const user = await requireAuthenticatedUser(request);
    const params = await context.params;
    const roomId = parseUuid(params.roomId, "roomId");
    const sessionId = parseUuid(params.sessionId, "sessionId");
    const url = new URL(request.url);
    const parsedLimit = limitSchema.safeParse(url.searchParams.get("limit") ?? undefined);
    if (!parsedLimit.success) throw new ApiProblem({ status: 422, code: "VALIDATION_ERROR", message: "The message limit is invalid.", issues: [{ path: "limit", reason: "Must be an integer from 1 through 200." }] });
    const before = url.searchParams.get("before") ?? undefined;
    return successResponse(await listPrivateMessages(roomId, sessionId, user.id, { limit: parsedLimit.data, before }), { requestId });
  });
}

export async function POST(request: Request, context: Context): Promise<Response> {
  return routeResponse(async (requestId) => {
    const user = await requireAuthenticatedUser(request);
    const params = await context.params;
    const roomId = parseUuid(params.roomId, "roomId");
    const sessionId = parseUuid(params.sessionId, "sessionId");
    const body = await parseJsonBody(request, sendMessageRequestSchema);
    const result = await sendPrivateMessage(roomId, sessionId, user.id, body.clientMessageId, body.content);
    return successResponse(result.data, { status: result.status, requestId });
  });
}
