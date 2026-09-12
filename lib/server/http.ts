import "server-only";

import { randomUUID } from "node:crypto";
import type { ApiError, ApiResponse } from "../../contracts/http";
import { normalizeProblem } from "./errors.ts";

const NO_STORE_HEADERS = {
  "Cache-Control": "no-store",
  "Content-Type": "application/json; charset=utf-8",
};

export function createRequestId(): string {
  return randomUUID();
}

export function successResponse<T>(
  data: T,
  options: { status?: number; requestId?: string; headers?: HeadersInit } = {},
): Response {
  const payload: ApiResponse<T> = {
    data,
    requestId: options.requestId ?? createRequestId(),
  };
  return Response.json(payload, {
    status: options.status ?? 200,
    headers: { ...NO_STORE_HEADERS, ...options.headers },
  });
}

export function emptyResponse(status = 204, headers?: HeadersInit): Response {
  return new Response(null, {
    status,
    headers: { "Cache-Control": "no-store", ...headers },
  });
}

export function errorResponse(error: unknown, requestId = createRequestId()): Response {
  const problem = normalizeProblem(error);
  const payload: ApiError = {
    error: {
      code: problem.code,
      message: problem.message,
      retryable: problem.retryable,
      issues: problem.issues,
      userMessageId: problem.userMessageId,
      retryAfterMs: problem.retryAfterMs,
    },
    requestId,
  };
  const headers: Record<string, string> = { ...NO_STORE_HEADERS };
  if (problem.status === 401) headers["WWW-Authenticate"] = "Bearer";
  if (problem.retryAfterMs !== null) {
    headers["Retry-After"] = String(Math.max(1, Math.ceil(problem.retryAfterMs / 1000)));
  }
  return Response.json(payload, { status: problem.status, headers });
}

export async function routeResponse(
  handler: (requestId: string) => Response | Promise<Response>,
): Promise<Response> {
  const requestId = createRequestId();
  try {
    return await handler(requestId);
  } catch (error) {
    return errorResponse(error, requestId);
  }
}
