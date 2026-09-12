import { isLocalRequest, issueDebugToken, validateJoin } from "../../../lib/token";

export const runtime = "nodejs";

function reply(body: unknown, status = 200) {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

export async function POST(request: Request) {
  if (process.env.NODE_ENV !== "development" || process.env.AUDIO_DEBUG_ENABLED !== "1") {
    return reply({ error: "本地音频测试未启用。" }, 404);
  }
  if (!isLocalRequest(request)) return reply({ error: "仅允许本机同源请求。" }, 403);
  if (request.headers.get("content-type")?.split(";")[0] !== "application/json") {
    return reply({ error: "需要 JSON 请求。" }, 415);
  }
  let input;
  try {
    const reader = request.body?.getReader();
    if (!reader) return reply({ error: "缺少入会信息。" }, 400);
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 2048) {
        await reader.cancel();
        return reply({ error: "请求过大。" }, 413);
      }
      chunks.push(value);
    }
    input = validateJoin(JSON.parse(Buffer.concat(chunks).toString("utf8")));
  } catch {
    return reply({ error: "入会信息格式不正确。" }, 400);
  }
  if (!input) return reply({ error: "房间名限 1–48 位字母、数字、下划线或连字符；姓名限 1–40 字。" }, 422);
  const url = process.env.LIVEKIT_URL;
  const key = process.env.LIVEKIT_API_KEY;
  const secret = process.env.LIVEKIT_API_SECRET;
  if (!url || !key || !secret) return reply({ error: "请在根目录 .env.local 配置三个 LIVEKIT 环境变量，再重启测试应用。" }, 503);
  try {
    return reply(await issueDebugToken(input, { url, key, secret }));
  } catch {
    return reply({ error: "无法签发测试凭证，请检查服务端 LiveKit 配置。" }, 503);
  }
}
