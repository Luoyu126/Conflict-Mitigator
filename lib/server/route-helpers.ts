import "server-only";
import type { DatabaseExecutor } from "../db/postgres";
import { runIdempotent, type JsonValue } from "./idempotency.ts";
import { successResponse } from "./http.ts";
import { requireIdempotencyKey } from "./validation.ts";

export async function idempotentCommand(
  request: Request, requestId: string, authUserId: string, body: unknown, status: number,
  handler: (db: DatabaseExecutor) => Promise<unknown>,
): Promise<Response> {
  const result = await runIdempotent({
    authUserId, method: request.method, path: new URL(request.url).pathname,
    idempotencyKey: requireIdempotencyKey(request), body: body as JsonValue,
  }, async (db) => ({ status, body: await handler(db) as JsonValue }));
  return successResponse(result.body, {
    status: result.status, requestId,
    headers: result.replayed ? { "Idempotency-Replayed": "true" } : undefined,
  });
}

export async function idempotentCommandWithStatus(
  request: Request, requestId: string, authUserId: string, body: unknown,
  handler: (db: DatabaseExecutor) => Promise<{ status: number; body: unknown }>,
): Promise<Response> {
  const result = await runIdempotent<JsonValue>({
    authUserId, method: request.method, path: new URL(request.url).pathname,
    idempotencyKey: requireIdempotencyKey(request), body: body as JsonValue,
  }, async (db) => {
    const outcome = await handler(db);
    return { status: outcome.status, body: outcome.body as JsonValue };
  });
  return successResponse(result.body, {
    status: result.status, requestId,
    headers: result.replayed ? { "Idempotency-Replayed": "true" } : undefined,
  });
}
