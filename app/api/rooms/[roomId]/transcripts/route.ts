import { z } from "zod";
import { requireAuthenticatedUser } from "@/lib/server/auth.ts";
import { ApiProblem } from "@/lib/server/errors.ts";
import { routeResponse, successResponse } from "@/lib/server/http.ts";
import { parseUuid } from "@/lib/server/validation.ts";
import { listTranscripts } from "@/services/transcripts";

type Context = { params: Promise<{ roomId: string }> };
const limitSchema = z.coerce.number().int().min(1).max(200).default(100);
export async function GET(request: Request, context: Context): Promise<Response> {
  return routeResponse(async (requestId) => {
    const user = await requireAuthenticatedUser(request);
    const roomId = parseUuid((await context.params).roomId, "roomId");
    const url = new URL(request.url);
    const parsedLimit = limitSchema.safeParse(url.searchParams.get("limit") ?? undefined);
    if (!parsedLimit.success) throw new ApiProblem({ status: 422, code: "VALIDATION_ERROR", message: "The transcript limit is invalid.", issues: [{ path: "limit", reason: "Must be an integer from 1 through 200." }] });
    const before = url.searchParams.get("before") ?? undefined;
    return successResponse(await listTranscripts(roomId, user.id, { limit: parsedLimit.data, before }), { requestId });
  });
}
