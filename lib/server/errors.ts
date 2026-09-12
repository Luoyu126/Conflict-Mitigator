import "server-only";

import type { FieldIssue } from "../../contracts/http";

export type ApiProblemOptions = {
  status: number;
  code: string;
  message: string;
  retryable?: boolean;
  issues?: FieldIssue[];
  userMessageId?: string | null;
  retryAfterMs?: number | null;
};

export class ApiProblem extends Error {
  readonly status: number;
  readonly code: string;
  readonly retryable: boolean;
  readonly issues: FieldIssue[];
  readonly userMessageId: string | null;
  readonly retryAfterMs: number | null;

  constructor(options: ApiProblemOptions) {
    super(options.message);
    this.name = "ApiProblem";
    this.status = options.status;
    this.code = options.code;
    this.retryable = options.retryable ?? false;
    this.issues = options.issues ?? [];
    this.userMessageId = options.userMessageId ?? null;
    this.retryAfterMs = options.retryAfterMs ?? null;
  }
}

export function internalProblem(): ApiProblem {
  return new ApiProblem({
    status: 500,
    code: "INTERNAL_ERROR",
    message: "An unexpected server error occurred.",
    retryable: true,
  });
}

export function normalizeProblem(error: unknown): ApiProblem {
  return error instanceof ApiProblem ? error : internalProblem();
}
