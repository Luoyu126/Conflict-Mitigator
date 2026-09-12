import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";
import postgres from "postgres";

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function listen(server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return server.address().port;
}
async function unusedPort() {
  const probe = createServer();
  const port = await listen(probe);
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

/** Starts actual Next Route Handlers and a local Supabase /user substitute.
 * Only this test's generated auth subjects/rooms are deleted during cleanup.
 * No media connection, worker supervisor, or billable provider is started.
 */
export async function createHttpHarness() {
  const databaseUrl = process.env.CM_HTTP_DATABASE_URL || process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("Provide the disposable PostgreSQL DATABASE_URL before running HTTP tests.");
  if (!["localhost", "127.0.0.1", "[::1]"].includes(new URL(databaseUrl).hostname)) {
    throw new Error("HTTP tests require a disposable database on localhost.");
  }
  const appDir = process.env.CM_HTTP_APP_DIR || fileURLToPath(new URL("../../", import.meta.url));
  const users = Object.fromEntries(["owner", "guest", "outsider"].map((name) => [name, { id: randomUUID(), token: `http-test-${randomUUID()}` }]));
  const workerToken = `worker-test-${randomUUID()}`;
  const inferenceToken = `inference-test-${randomUUID()}`;
  const knownUsers = new Map(Object.values(users).map((user) => [`Bearer ${user.token}`, user]));
  let authRequests = 0;
  const auth = createServer((request, response) => {
    response.setHeader("Content-Type", "application/json");
    response.setHeader("Cache-Control", "no-store");
    if (request.method !== "GET" || request.url !== "/auth/v1/user") {
      response.writeHead(404); response.end(JSON.stringify({ message: "Unexpected fake-auth route" })); return;
    }
    authRequests++;
    const user = knownUsers.get(request.headers.authorization);
    if (!user) { response.writeHead(401); response.end(JSON.stringify({ message: "Invalid test bearer", code: "bad_jwt" })); return; }
    response.end(JSON.stringify({ id: user.id, aud: "authenticated", role: "authenticated", is_anonymous: true,
      app_metadata: {}, user_metadata: {}, identities: [], created_at: "2026-09-12T00:00:00.000Z" }));
  });
  const db = postgres(databaseUrl, { max: 1, prepare: false, onnotice: () => undefined });
  let child;
  let output = "";
  let closed = false;
  const roomIds = [];
  const cleanup = async () => {
    if (closed) return;
    closed = true;
    if (child) {
      try { process.kill(-child.pid, "SIGTERM"); } catch { /* already exited */ }
      if (child.exitCode === null && child.signalCode === null) await Promise.race([once(child, "exit"), delay(5000)]);
      try { process.kill(-child.pid, "SIGKILL"); } catch { /* group is gone */ }
    }
    auth.closeAllConnections();
    await new Promise((resolve) => auth.close(resolve));
    try {
      if (roomIds.length) {
        await db`UPDATE rooms SET active_mediation_session_id=NULL,active_mediation_node_id=NULL WHERE id=ANY(${roomIds}::uuid[])`;
        await db`DELETE FROM rooms WHERE id=ANY(${roomIds}::uuid[])`;
      }
      // Covers a create request that committed before an assertion/response failed.
      const subjects = Object.values(users).map((user) => user.id);
      await db`DELETE FROM rooms WHERE created_by=ANY(${subjects}::uuid[])`;
      await db`DELETE FROM idempotency_records WHERE auth_user_id=ANY(${subjects}::uuid[])`;
    } finally { await db.end({ timeout: 5 }); }
  };
  try {
    await db`SELECT 1`;
    const authPort = await listen(auth);
    const appPort = await unusedPort();
    const origin = `http://127.0.0.1:${appPort}`;
    child = spawn(process.execPath, [path.join(appDir, "node_modules/next/dist/bin/next"), "dev", "--webpack", "--hostname", "127.0.0.1", "--port", String(appPort)], {
      cwd: appDir, detached: true, stdio: ["ignore", "pipe", "pipe"], env: {
        ...process.env, NODE_ENV: "development", NEXT_TELEMETRY_DISABLED: "1", DATABASE_URL: databaseUrl,
        NEXT_PUBLIC_SUPABASE_URL: `http://127.0.0.1:${authPort}`, NEXT_PUBLIC_SUPABASE_ANON_KEY: "http-test-anon-key",
        SUPABASE_SERVICE_ROLE_KEY: "http-test-service-role", WORKER_SERVICE_TOKEN: workerToken, INFERENCE_SERVICE_TOKEN: inferenceToken,
        CRON_SECRET: "http-test-cron", LIVEKIT_URL: "wss://unit.test", LIVEKIT_API_KEY: "http-test-livekit-key",
        LIVEKIT_API_SECRET: "http-test-livekit-secret-at-least-32-characters", APP_ORIGIN: origin, INFERENCE_ORIGIN: origin,
        FACEPLUSPLUS_API_KEY: "", FACEPLUSPLUS_API_SECRET: "", HUME_API_KEY: "", GEMINI_API_KEY: "", GOOGLE_API_KEY: "",
      },
    });
    const record = (chunk) => { output = (output + chunk.toString()).slice(-20000); };
    child.stdout.on("data", record); child.stderr.on("data", record);
    const deadline = Date.now() + 90_000;
    let ready = false;
    while (Date.now() < deadline) {
      if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Next exited before readiness.\n${output}`);
      try {
        const response = await fetch(`${origin}/api/rooms`, { signal: AbortSignal.timeout(1500) });
        await response.arrayBuffer();
        if (response.status === 405) { ready = true; break; }
      } catch { /* server or route compilation is still starting */ }
      await delay(150);
    }
    if (!ready) throw new Error(`Next failed to become ready within 90 seconds.\n${output}`);
    async function request(route, options = {}) {
      const { method = "GET", as, token = as ? users[as].token : undefined, body, idempotencyKey, runId } = options;
      const headers = new Headers();
      if (token) headers.set("Authorization", `Bearer ${token}`);
      if (body !== undefined) headers.set("Content-Type", "application/json");
      if (idempotencyKey) headers.set("Idempotency-Key", idempotencyKey);
      if (runId) headers.set("X-Worker-Run-Id", runId);
      const response = await fetch(`${origin}${route}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(45_000) });
      const text = await response.text();
      let payload;
      try { payload = text ? JSON.parse(text) : null; }
      catch { throw new Error(`Non-JSON HTTP ${response.status} from ${method} ${route}.\n${output}`); }
      if (response.status >= 500) throw new Error(`HTTP ${response.status} from ${method} ${route}: ${JSON.stringify(payload)}\n${output}`);
      return { status: response.status, headers: response.headers, payload };
    }
    return { users, workerToken, inferenceToken, db, roomIds, request, cleanup, get authRequests() { return authRequests; } };
  } catch (error) { await cleanup(); throw error; }
}
