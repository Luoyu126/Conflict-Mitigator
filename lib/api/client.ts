"use client";
import type { ApiError, ApiResponse } from "../../contracts/http";
import { ensureAnonymousSession } from "../supabase/client";

export class ApiClientError extends Error {
  constructor(readonly status: number, readonly detail: ApiError["error"]) {
    super(detail.message); this.name = "ApiClientError";
  }
}
export async function apiRequest<T>(path: string, init: RequestInit & { idempotencyKey?: string } = {}): Promise<ApiResponse<T>> {
  const token = await ensureAnonymousSession();
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${token}`);
  if (init.body !== undefined) headers.set("Content-Type", "application/json");
  if (init.idempotencyKey) headers.set("Idempotency-Key", init.idempotencyKey);
  const response = await fetch(path, { ...init, headers, cache: "no-store" });
  const payload = await response.json() as ApiResponse<T> | ApiError;
  if (!response.ok) throw new ApiClientError(response.status, (payload as ApiError).error);
  return payload as ApiResponse<T>;
}
