export type Publication = {
  identity: string; sid: string; source: "microphone" | "camera" | "other"; muted: boolean; subscribed: boolean;
  subscribe(value: boolean): void;
};
export type CameraFrame = {
  timestampUs: string; receivedAt: number;
  encode(): Promise<{ jpeg: Uint8Array; width: number; height: number }>;
};
export interface WorkerMedia {
  connect(signal: AbortSignal): Promise<void>;
  close(): Promise<void>;
  isConnected(): boolean;
  publications(): Publication[];
  onChange(callback: () => void): void;
  onData(callback: (payload: Uint8Array, identity: string | undefined, reliable: boolean, topic: string | undefined) => void): void;
  audio(publication: Publication, signal: AbortSignal, onFrame: (frame: Int16Array) => void): Promise<void>;
  video(publication: Publication, signal: AbortSignal, onFrame: (frame: CameraFrame) => void): Promise<void>;
}
export interface MediaAdmin {
  remove(identity: string, cutoff: number, signal: AbortSignal): Promise<void>;
  deleteRoom(signal: AbortSignal): Promise<void>;
}

export async function bounded<T>(operation: Promise<T>, signal: AbortSignal, timeoutMs = 10_000): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("Operation timed out.")), timeoutMs);
  const abort = () => controller.abort(signal.reason);
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  let listener: (() => void) | undefined;
  try {
    controller.signal.throwIfAborted();
    return await Promise.race([operation, new Promise<never>((_, reject) => {
      listener = () => reject(controller.signal.reason);
      controller.signal.addEventListener("abort", listener, { once: true });
    })]);
  } finally {
    clearTimeout(timer); signal.removeEventListener("abort", abort);
    if (listener) controller.signal.removeEventListener("abort", listener);
  }
}
export function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    const done = () => { clearTimeout(timer); signal.removeEventListener("abort", done); resolve(); };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
    if (signal.aborted) done();
  });
}
