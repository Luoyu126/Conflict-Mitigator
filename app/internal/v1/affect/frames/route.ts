import { requireServiceToken } from "@/lib/server/auth.ts";
import { routeResponse } from "@/lib/server/http.ts";
import { ApiProblem } from "@/lib/server/errors.ts";

export async function POST(request: Request): Promise<Response> {
  return routeResponse(async () => {
    requireServiceToken(request, "INFERENCE_SERVICE_TOKEN");
    throw new ApiProblem({ status: 409, code: "FEATURE_DISABLED", message: "Visual affect analysis is disabled for this product version." });
  });
}
