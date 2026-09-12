import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import WebSocket, { WebSocketServer } from "ws";
import { isEmotionOrigin, parseEmotionMessage } from "./lib/emotions.ts";

let local = {};
try { local = parseEnv(readFileSync(new URL("./.env.hume.local", import.meta.url), "utf8")); }
catch (error) { if (error.code !== "ENOENT") throw error; }
const apiKey = process.env.HUME_API_KEY || local.HUME_API_KEY;
const configId = process.env.HUME_CONFIG_ID || local.HUME_CONFIG_ID;
const server = createServer((_req, res) => { res.writeHead(404); res.end(); });
const sockets = new WebSocketServer({ noServer: true, maxPayload: 65536 });
server.on("upgrade", (req, socket, head) => {
  if (req.url !== "/evi" || !isEmotionOrigin(req.headers.origin, req.headers.host) || sockets.clients.size >= 3) {
    socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n"); return;
  }
  sockets.handleUpgrade(req, socket, head, client => sockets.emit("connection", client));
});
sockets.on("connection", client => {
  let upstream; let initialized = false; let ready = false; let finished = false;
  let lastAudioAt = Date.now(); let bytesInWindow = 0; let windowStart = Date.now();
  let sampleRate = 24000;
  const send = value => { if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify(value)); };
  const finish = message => {
    if (finished) return; finished = true;
    if (message) send({ type: "error", message });
    clearTimeout(limit); clearInterval(idle);
    if (upstream) upstream.terminate();
    client.close();
  };
  const limit = setTimeout(() => finish("本轮已达到 5 分钟，分析已停止；可手动开始下一轮。"), 300000);
  const idle = setInterval(() => {
    if (Date.now() - lastAudioAt > 15000) finish("音频流已中断，分析已停止。请重新开始。" );
  }, 3000);
  client.on("close", () => finish()); client.on("error", () => finish());
  client.on("message", (data, binary) => {
    if (finished) return;
    if (binary) {
      if (!ready || !upstream || data.length === 0 || data.length % 2) { finish("音频数据格式不正确。"); return; }
      if (Date.now() - windowStart >= 1000) { windowStart = Date.now(); bytesInWindow = 0; }
      bytesInWindow += data.length;
      if (bytesInWindow > sampleRate * 2 * 3 || upstream.bufferedAmount > 256000) { finish("音频传输积压，分析已停止。请检查网络后重试。"); return; }
      lastAudioAt = Date.now();
      upstream.send(JSON.stringify({ type: "audio_input", data: data.toString("base64") })); return;
    }
    let message;
    try { message = JSON.parse(data.toString()); } catch { finish("请求格式不正确。"); return; }
    if (!message || typeof message !== "object" || initialized || message.type !== "start" || !Number.isInteger(message.sampleRate)
      || message.sampleRate < 8000 || message.sampleRate > 96000) { finish("音频设置不正确。"); return; }
    initialized = true; sampleRate = message.sampleRate;
    if (!apiKey) { finish("请在 debug/.env.hume.local 配置 HUME_API_KEY 并重启测试服务。"); return; }
    const endpoint = new URL("wss://api.hume.ai/v0/evi/chat");
    endpoint.searchParams.set("verbose_transcription", "true");
    if (configId) endpoint.searchParams.set("config_id", configId);
    upstream = new WebSocket(endpoint, {
      headers: { "X-Hume-Api-Key": apiKey }, handshakeTimeout: 10000, maxPayload: 2 * 1024 * 1024,
    });
    upstream.on("open", () => {
      upstream.send(JSON.stringify({ type: "session_settings", audio: { encoding: "linear16", sample_rate: sampleRate, channels: 1 } }));
    });
    upstream.on("message", raw => {
      let event; try { event = JSON.parse(raw.toString()); } catch { finish("Hume 返回了无法解析的结果。"); return; }
      if (!event || typeof event !== "object") { finish("Hume 返回了无法解析的结果。"); return; }
      if (event.type === "chat_metadata") { ready = true; lastAudioAt = Date.now(); send({ type: "ready" }); }
      if (event.type === "error") { finish("Hume 拒绝了本次分析，请检查账号余额、EVI 权限或稍后重试。"); return; }
      const observation = parseEmotionMessage(event);
      if (observation) send(observation);
      // Do not forward assistant text/audio or provider session identifiers.
    });
    upstream.on("unexpected-response", (_request, response) => {
      response.resume(); finish(`Hume 连接失败（HTTP ${response.statusCode}），请检查 EVI 权限和账户状态。`);
    });
    upstream.on("error", () => finish("无法连接 Hume，请检查网络和服务端配置。"));
    upstream.on("close", () => finish("Hume 连接已结束，请重新开始分析。"));
  });
});
server.on("error", error => { console.error(`EVI 本地服务启动失败：${error.code ?? "unknown"}`); process.exit(1); });
server.listen(3002, "127.0.0.1", () => console.log("Hume EVI 本地转发已就绪：127.0.0.1:3002"));
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => {
  for (const client of sockets.clients) client.terminate();
  server.close();
});
