import "server-only";

import { z } from "zod";
import { ApiProblem } from "./errors.ts";

export const uuidSchema = z.string().uuid();

function validationProblem(error: z.ZodError): ApiProblem {
  return new ApiProblem({
    status: 422,
    code: "VALIDATION_ERROR",
    message: "The request did not match the API contract.",
    issues: error.issues.map((issue) => ({
      path: issue.path.length ? issue.path.map(String).join(".") : "$",
      reason: issue.message,
    })),
  });
}

export async function parseJsonBody<T>(
  request: Request,
  schema: z.ZodType<T>,
  maxBytes = 64 * 1024,
): Promise<T> {
  const contentType = request.headers.get("content-type")?.toLowerCase() ?? "";
  if (!contentType.startsWith("application/json")) {
    throw new ApiProblem({
      status: 400,
      code: "INVALID_REQUEST",
      message: "Content-Type must be application/json.",
    });
  }

  const declaredLength = request.headers.get("content-length");
  if (declaredLength !== null && Number(declaredLength) > maxBytes) {
    throw new ApiProblem({
      status: 413,
      code: "PAYLOAD_TOO_LARGE",
      message: "The request body is too large.",
    });
  }

  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > maxBytes) {
    throw new ApiProblem({
      status: 413,
      code: "PAYLOAD_TOO_LARGE",
      message: "The request body is too large.",
    });
  }

  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new ApiProblem({
      status: 400,
      code: "INVALID_REQUEST",
      message: "The request body is not valid JSON.",
    });
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw validationProblem(parsed.error);
  return parsed.data;
}

export function parseUuid(value: string, path: string): string {
  const parsed = uuidSchema.safeParse(value);
  if (!parsed.success) {
    throw new ApiProblem({
      status: 422,
      code: "VALIDATION_ERROR",
      message: "The request did not match the API contract.",
      issues: [{ path, reason: "Must be a UUID." }],
    });
  }
  return parsed.data;
}

export function requireIdempotencyKey(request: Request): string {
  const value = request.headers.get("idempotency-key");
  if (!value) {
    throw new ApiProblem({
      status: 400,
      code: "INVALID_REQUEST",
      message: "Idempotency-Key is required.",
    });
  }
  return parseUuid(value, "Idempotency-Key");
}
