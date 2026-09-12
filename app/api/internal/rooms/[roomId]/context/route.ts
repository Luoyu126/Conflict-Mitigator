import { requireServiceToken, requireWorkerRunId } from "@/lib/server/auth.ts";
import { getDatabase } from "@/lib/db/postgres.ts";
import { routeResponse, successResponse } from "@/lib/server/http.ts";
import { parseUuid } from "@/lib/server/validation.ts";
import { getWorkerContext } from "@/services/worker";

type Context = { params: Promise<{ roomId: string }> };
export async function GET(request: Request, context: Context): Promise<Response> {
  return routeResponse(async (requestId) => {
    requireServiceToken(request, "WORKER_SERVICE_TOKEN");
    const runId = requireWorkerRunId(request);
    const roomId = parseUuid((await context.params).roomId, "roomId");
    return successResponse(await getWorkerContext(getDatabase(), roomId, runId), { requestId });
  });
}
