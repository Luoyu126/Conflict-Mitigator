import { randomUUID } from "node:crypto";
import { bounded, wait } from "./media-types.ts";

export interface SupervisedWorker { run(): Promise<void>; stop(): Promise<void> }
export type SupervisorDependencies = {
  discover(): Promise<string[]>;
  maintenance(): Promise<void>;
  create(roomId: string, runId: string): SupervisedWorker;
  log?: (message: string) => void;
  intervalMs?: number;
};

/** One bounded process lifecycle per discovered room. The server lease arbitrates across supervisors. */
export async function runSupervisor(dependencies: SupervisorDependencies, signal: AbortSignal): Promise<void> {
  const running = new Map<string, { worker: SupervisedWorker; done: Promise<void> }>();
  const retryAt = new Map<string, number>();
  try {
    while (!signal.aborted) {
      try {
        await bounded(dependencies.maintenance(), signal);
        const rooms = new Set(await bounded(dependencies.discover(), signal));
        for (const [roomId, value] of running) if (!rooms.has(roomId)) {
          await value.worker.stop(); await value.done; running.delete(roomId);
        }
        for (const roomId of rooms) {
          if (running.has(roomId) || Date.now() < (retryAt.get(roomId) ?? 0)) continue;
          const worker = dependencies.create(roomId, randomUUID());
          const done = worker.run().catch(() => dependencies.log?.("Room Worker stopped; lease-safe retry is scheduled."))
            .finally(() => { if (running.get(roomId)?.worker === worker) running.delete(roomId); retryAt.set(roomId, Date.now() + 5000); });
          running.set(roomId, { worker, done });
        }
        for (const roomId of retryAt.keys()) if (!rooms.has(roomId)) retryAt.delete(roomId);
      } catch { dependencies.log?.("Worker discovery or maintenance failed; retrying without exposing data."); }
      await wait(dependencies.intervalMs ?? 2000, signal);
    }
  } finally {
    await Promise.allSettled([...running.values()].map(async value => { await value.worker.stop(); await value.done; }));
  }
}
