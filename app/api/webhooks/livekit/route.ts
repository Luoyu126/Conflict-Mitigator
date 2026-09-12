import { getDatabase } from "@/lib/db/postgres.ts";
import { emptyResponse, routeResponse } from "@/lib/server/http.ts";
import { verifyAndRecordWebhook } from "@/services/worker";

export async function POST(request: Request): Promise<Response> {
  return routeResponse(async () => {
    const rawBody = await request.text();
    const authorization = request.headers.get("authorization");
    await verifyAndRecordWebhook(getDatabase(), rawBody, authorization);
    return emptyResponse(204);
  });
}
