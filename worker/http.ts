import type { WorkerContext, WorkerLeaseData, WorkerStatusRequest } from "../contracts/worker.ts";
import type { AffectResult, FrameMetadata } from "../contracts/affect.ts";

export class WorkerHttpError extends Error {
  readonly status: number;
  constructor(status: number) { super(`Worker request failed (${status}).`); this.status = status; }
}
export interface WorkerTransport {
  status(body: WorkerStatusRequest, signal: AbortSignal): Promise<WorkerLeaseData>;
  context(signal: AbortSignal): Promise<WorkerContext>;
  post(path: string, body: unknown, signal: AbortSignal): Promise<unknown>;
  infer(metadata: FrameMetadata, jpeg: Uint8Array, signal: AbortSignal): Promise<AffectResult>;
}
export function createWorkerTransport(config: { appOrigin: string; inferenceOrigin: string; roomId: string; runId: string; workerToken: string; inferenceToken: string }, fetcher: typeof fetch = fetch): WorkerTransport {
  const base = `/api/internal/rooms/${config.roomId}`;
  async function request<T>(origin: string, path: string, signal: AbortSignal, token: string, body?: unknown): Promise<T> {
    const multipart = body instanceof FormData;
    const response = await fetcher(new URL(path, origin), {
      method: body === undefined ? "GET" : "POST", redirect: "error",
      headers: { Authorization: `Bearer ${token}`, "X-Worker-Run-Id": config.runId, ...(body !== undefined && !multipart ? { "Content-Type": "application/json" } : {}) },
      ...(body === undefined ? {} : { body: multipart ? body : JSON.stringify(body) }),
      signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
    });
    if (!response.ok) { await response.body?.cancel(); throw new WorkerHttpError(response.status); }
    const payload = await response.json() as { data: T };
    return payload.data;
  }
  return {
    status: (body, signal) => request<WorkerLeaseData>(config.appOrigin, `${base}/worker-status`, signal, config.workerToken, body),
    context: signal => request<WorkerContext>(config.appOrigin, `${base}/context`, signal, config.workerToken),
    post: (path, body, signal) => request(config.appOrigin, `${base}/${path}`, signal, config.workerToken, body),
    infer: (metadata, jpeg, signal) => {
      const form = new FormData();
      form.set("metadata", new Blob([JSON.stringify(metadata)], { type: "application/json" }), "metadata.json");
      form.set("frame", new Blob([Uint8Array.from(jpeg)], { type: "image/jpeg" }), "frame.jpg");
      return request<AffectResult>(config.inferenceOrigin, "/internal/v1/affect/frames", signal, config.inferenceToken, form);
    },
  };
}
