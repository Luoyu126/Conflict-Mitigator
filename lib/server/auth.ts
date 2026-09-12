import "server-only";

import { timingSafeEqual } from "node:crypto";
import { ApiProblem } from "./errors.ts";
import { readServerSecret } from "./env.ts";
import { getSupabaseAuthClient } from "./supabase.ts";
import { parseUuid } from "./validation.ts";

export type AuthenticatedUser = {
  id: string;
  isAnonymous: boolean;
};

export function extractBearerToken(request: Request): string {
  const authorization = request.headers.get("authorization")?.trim() ?? "";
  const match = /^Bearer ([^\s,]+)$/i.exec(authorization);
  if (!match || match[1].length > 16_384) {
    throw new ApiProblem({
      status: 401,
      code: "UNAUTHENTICATED",
      message: "A valid bearer token is required.",
    });
  }
  return match[1];
}

export async function requireAuthenticatedUser(request: Request): Promise<AuthenticatedUser> {
  const token = extractBearerToken(request);
  const { data, error } = await getSupabaseAuthClient().auth.getUser(token);
  if (error || !data.user) {
    throw new ApiProblem({
      status: 401,
      code: "UNAUTHENTICATED",
      message: "The authentication session is invalid or expired.",
    });
  }
  return {
    id: data.user.id,
    isAnonymous: data.user.is_anonymous === true,
  };
}

function constantTimeEqual(actual: string, expected: string): boolean {
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  return actualBytes.length === expectedBytes.length
    && timingSafeEqual(actualBytes, expectedBytes);
}

export function requireServiceToken(
  request: Request,
  secretName: "WORKER_SERVICE_TOKEN" | "INFERENCE_SERVICE_TOKEN" | "CRON_SECRET",
): void {
  const actual = extractBearerToken(request);
  const expected = readServerSecret(secretName);
  if (!constantTimeEqual(actual, expected)) {
    throw new ApiProblem({
      status: 401,
      code: "UNAUTHENTICATED",
      message: "The service credential is invalid.",
    });
  }
}

export function requireWorkerRunId(request: Request): string {
  const value = request.headers.get("x-worker-run-id");
  if (!value) {
    throw new ApiProblem({
      status: 400,
      code: "INVALID_REQUEST",
      message: "X-Worker-Run-Id is required.",
    });
  }
  return parseUuid(value, "X-Worker-Run-Id");
}
