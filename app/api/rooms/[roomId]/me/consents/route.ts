import { consentPatchSchema } from "@/contracts/rooms";
import { requireAuthenticatedUser } from "@/lib/server/auth.ts";
import { routeResponse } from "@/lib/server/http.ts";
import { idempotentCommand } from "@/lib/server/route-helpers.ts";
import { parseJsonBody, parseUuid } from "@/lib/server/validation.ts";
import { updateConsents } from "@/services/rooms";

type Context = { params: Promise<{ roomId: string }> };
export async function PATCH(request: Request, context: Context): Promise<Response> {
  return routeResponse(async (requestId) => {
    const user = await requireAuthenticatedUser(request);
    const roomId = parseUuid((await context.params).roomId, "roomId");
    const body = await parseJsonBody(request, consentPatchSchema);
    return idempotentCommand(request, requestId, user.id, body, 200, (db) => updateConsents(db, roomId, user.id, body));
  });
}
