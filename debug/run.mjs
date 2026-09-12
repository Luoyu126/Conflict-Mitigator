import { readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

// Only inherit the three LiveKit settings; never copy or print credentials.
let local = {};
try {
  local = parseEnv(readFileSync(new URL("../.env.local", import.meta.url), "utf8"));
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
for (const key of ["LIVEKIT_URL", "LIVEKIT_API_KEY", "LIVEKIT_API_SECRET"]) {
  if (!process.env[key] && local[key]) process.env[key] = local[key];
}
process.env.AUDIO_DEBUG_ENABLED = "1";
const cwd = fileURLToPath(new URL(".", import.meta.url));
const evi = spawn(process.execPath, [fileURLToPath(new URL("./evi-server.mjs", import.meta.url))], {
  cwd, env: process.env, stdio: "inherit",
});
const child = spawn(process.execPath, [
  fileURLToPath(new URL("./node_modules/next/dist/bin/next", import.meta.url)),
  "dev", "--hostname", "127.0.0.1", "--port", "3001",
], { cwd, env: process.env, stdio: "inherit" });
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => { child.kill(signal); evi.kill(signal); });
}
child.on("error", () => {
  console.error("无法启动测试应用，请先运行 npm --prefix debug install。");
  process.exitCode = 1;
});
child.on("exit", (code) => { evi.kill(); process.exitCode = code ?? 0; });
evi.on("error", () => { console.error("无法启动 Hume 本地转发服务。"); child.kill(); process.exitCode = 1; });
evi.on("exit", (code) => { if (code) { child.kill(); process.exitCode = code; } });
