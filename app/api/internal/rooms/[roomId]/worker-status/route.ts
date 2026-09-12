import { workerStatusRequestSchema } from "@/contracts/worker";
import { requireServiceToken } from "@/lib/server/auth.ts";
import { withTransaction } from "@/lib/db/postgres.ts";
import { routeResponse, successResponse } from "@/lib/server/http.ts";
import { parseJsonBody, parseUuid } from "@/lib/server/validation.ts";
import { upsertWorkerLease } from "@/services/worker";

type Context = { params: Promise<{ roomId: string }> };
export async function POST(request: Request, context: Context): Promise<Response> {
  return routeResponse(async (requestId) => {
    requireServiceToken(request, "WORKER_SERVICE_TOKEN");
    const roomId = parseUuid((await context.params).roomId, "roomId");
    const body = await parseJsonBody(request, workerStatusRequestSchema);
    return successResponse(await withTransaction((tx) => upsertWorkerLease(tx, roomId, body)), { requestId });
  });
}
