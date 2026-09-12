import { requireServiceToken, requireWorkerRunId } from "@/lib/server/auth.ts";
import { getDatabase } from "@/lib/db/postgres.ts";
import { routeResponse } from "@/lib/server/http.ts";
import { ApiProblem } from "@/lib/server/errors.ts";
import { parseUuid } from "@/lib/server/validation.ts";
import { requireWorkerLeaseForRoute } from "@/services/worker";

type Context = { params: Promise<{ roomId: string }> };
export async function POST(request: Request, context: Context): Promise<Response> {
  return routeResponse(async () => {
    requireServiceToken(request, "WORKER_SERVICE_TOKEN");
    const runId = requireWorkerRunId(request);
    const roomId = parseUuid((await context.params).roomId, "roomId");
    await requireWorkerLeaseForRoute(getDatabase(), roomId, runId);
    throw new ApiProblem({ status: 409, code: "FEATURE_DISABLED", message: "Visual affect analysis is disabled for this product version." });
  });
}
