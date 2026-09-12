import { transcriptIngestRequestSchema } from "@/contracts/worker";
import { requireServiceToken, requireWorkerRunId } from "@/lib/server/auth.ts";
import { getDatabase } from "@/lib/db/postgres.ts";
import { routeResponse, successResponse } from "@/lib/server/http.ts";
import { parseJsonBody, parseUuid } from "@/lib/server/validation.ts";
import { ingestTranscript, requireWorkerLeaseForRoute } from "@/services/worker";

type Context = { params: Promise<{ roomId: string }> };
export async function POST(request: Request, context: Context): Promise<Response> {
  return routeResponse(async (requestId) => {
    requireServiceToken(request, "WORKER_SERVICE_TOKEN");
    const runId = requireWorkerRunId(request);
    const roomId = parseUuid((await context.params).roomId, "roomId");
    const body = await parseJsonBody(request, transcriptIngestRequestSchema);
    await requireWorkerLeaseForRoute(getDatabase(), roomId, runId);
    return successResponse(await ingestTranscript(getDatabase(), roomId, body), { requestId });
  });
}
