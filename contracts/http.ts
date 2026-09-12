/** 通用 HTTP 类型，来源：docs/api/frontend-api.md §1、§4。 */
export type ApiResponse<T> = {
  data: T;
  requestId: string;
};

export type FieldIssue = {
  path: string;
  reason: string;
};

export type ErrorDetail = {
  code: string;
  message: string;
  retryable: boolean;
  issues: FieldIssue[];
  userMessageId: string | null;
  retryAfterMs: number | null;
};

export type ApiError = {
  error: ErrorDetail;
  requestId: string;
};
