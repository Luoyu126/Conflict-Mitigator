import { readFile } from "node:fs/promises";
import { parseEnv } from "node:util";
import path from "node:path";
import { isLocalRequest } from "../../../lib/token";
import { jpegDimensions, parseFaceResult } from "../../../lib/face-emotion";

export const runtime = "nodejs";
let busy = false;
let nextRequestAt = 0;
const reply = (body: unknown, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
export async function POST(request: Request) {
  if (process.env.NODE_ENV !== "development" || process.env.AUDIO_DEBUG_ENABLED !== "1") return reply({ error: "本地测试未启用。" }, 404);
  if (!isLocalRequest(request)) return reply({ error: "仅允许本机同源请求。" }, 403);
  if (request.headers.get("x-face-analysis-consent") !== "yes") return reply({ error: "请先同意将摄像头抽样帧发送至 Face++。" }, 403);
  if (request.headers.get("content-type") !== "image/jpeg") return reply({ error: "仅接受 JPEG。" }, 415);
  if (busy || Date.now() < nextRequestAt) return reply({ error: "请求过快，请稍后重试。" }, 429);
  busy = true;
  try {
    let local: Record<string, string | undefined> = {};
    try { local = parseEnv(await readFile(path.resolve(process.cwd(), ".env.faceplusplus.local"), "utf8")); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const key = process.env.FACEPLUSPLUS_API_KEY || local.FACEPLUSPLUS_API_KEY;
    const secret = process.env.FACEPLUSPLUS_API_SECRET || local.FACEPLUSPLUS_API_SECRET;
    const region = process.env.FACEPLUSPLUS_REGION || local.FACEPLUSPLUS_REGION || "us";
    if (!key || !secret || !["us", "cn"].includes(region)) return reply({ error: "请检查服务端 Face++ 密钥和区域配置。" }, 503);
    const reader = request.body?.getReader();
    if (!reader) return reply({ error: "缺少图片。" }, 400);
    const chunks: Uint8Array[] = []; let size = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 524288) { await reader.cancel(); return reply({ error: "图片不能超过 512 KiB。" }, 413); }
      chunks.push(value);
    }
    const bytes = Buffer.concat(chunks);
    const dimensions = jpegDimensions(bytes);
    if (!dimensions || Math.max(dimensions.width, dimensions.height) > 640 || Math.min(dimensions.width, dimensions.height) < 48) {
      return reply({ error: "需要 48–640 像素范围内的 JPEG 图片。" }, 422);
    }
    if (request.signal.aborted) return reply({ error: "分析已取消。" }, 499);
    const form = new FormData();
    form.set("api_key", key); form.set("api_secret", secret);
    form.set("return_attributes", "emotion,blur");
    form.set("image_file", new Blob([bytes], { type: "image/jpeg" }), "frame.jpg");
    const started = performance.now();
    const response = await fetch(`https://api-${region}.faceplusplus.com/facepp/v3/detect`, {
      method: "POST", body: form, cache: "no-store", redirect: "error",
      signal: AbortSignal.any([request.signal, AbortSignal.timeout(12000)]),
    });
    const data = await response.json();
    const errorCode = typeof data.error_message === "string" ? data.error_message.split(":")[0] : "";
    if (!response.ok || errorCode) {
      if (errorCode === "CONCURRENCY_LIMIT_EXCEEDED") { nextRequestAt = Date.now() + 5000; return reply({ error: "Face++ 免费并发额度已满，请稍后重试。" }, 429); }
      const message = errorCode === "AUTHENTICATION_ERROR" ? "Face++ 密钥校验失败，请检查密钥及账号区域。"
        : ["AUTHORIZATION_ERROR", "INSUFFICIENT_PERMISSION"].includes(errorCode) ? "Face++ 账号权限或额度不足，请检查控制台。"
        : "Face++ 未能处理图片，请稍后重试。";
      return reply({ error: message }, 502);
    }
    // Never forward face tokens, image IDs, raw provider errors, or credentials.
    return reply({ ...parseFaceResult(data), requestMs: Math.round(performance.now() - started) });
  } catch {
    return reply({ error: "Face++ 请求失败或超时，请检查网络后重试。" }, 502);
  } finally { busy = false; nextRequestAt = Math.max(nextRequestAt, Date.now() + 1000); }
}
