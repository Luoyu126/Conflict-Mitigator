import "server-only";

import { getDatabase, closeDatabase } from "../lib/db/postgres.ts";
import { runMaintenance } from "../services/media/maintenance.ts";
import { createWorkerTransport } from "./http.ts";
import { createNativeMedia, createMediaAdmin } from "./native-media.ts";
import { RoomWorker } from "./room-worker.ts";
import { runSupervisor } from "./supervisor.ts";
import { readLiveKitConfig } from "../lib/integrations/livekit.ts";
import { dispose } from "@livekit/rtc-node";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing Worker setting: ${name}.`);
  return value;
}
function origin(value: string): string {
  const url = new URL(value);
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== "/") throw new Error("Invalid Worker service origin.");
  return url.origin;
}
async function main() {
  const appOrigin = origin(required("APP_ORIGIN"));
  const inferenceOrigin = origin(process.env.INFERENCE_ORIGIN?.trim() || appOrigin);
  const workerToken = required("WORKER_SERVICE_TOKEN"), inferenceToken = required("INFERENCE_SERVICE_TOKEN");
  required("DATABASE_URL");
  readLiveKitConfig();
  if (process.argv.includes("--check")) {
    console.info("Media Worker configuration and native modules loaded; no provider connection was made.");
    await dispose(); return;
  }
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once("SIGINT", stop); process.once("SIGTERM", stop);
  const log = (message: string) => console.info(`[media-worker] ${message}`);
  try {
    await runSupervisor({
      async discover() {
        const rows = await getDatabase()<{ id: string }[]>`SELECT r.id FROM rooms r WHERE r.media_cleanup_pending
          OR EXISTS (SELECT 1 FROM participants p WHERE p.room_id=r.id AND (p.status='active' OR p.media_cleanup_pending))`;
        return rows.map(row => row.id);
      },
      maintenance: runMaintenance,
      create: (roomId, runId) => new RoomWorker({ roomId, runId,
        transport: createWorkerTransport({ appOrigin, inferenceOrigin, roomId, runId, workerToken, inferenceToken }),
        media: createNativeMedia(roomId, runId), admin: createMediaAdmin(roomId), log,
      }), log,
    }, controller.signal);
  } finally {
    process.removeListener("SIGINT", stop); process.removeListener("SIGTERM", stop);
    await closeDatabase(); await dispose();
  }
}
main().catch(error => {
  console.error(error instanceof Error && /^Missing Worker setting: [A-Z_]+\.$/.test(error.message)
    ? error.message : "Media Worker could not start or shut down cleanly. Check server configuration and availability.");
  process.exitCode = 1;
});
