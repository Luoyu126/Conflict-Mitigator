import { generateJson } from "./gemini.ts";

type Options = { signal?: AbortSignal; timeoutMs?: number; temperature?: number };

/** Server-side meeting analysis only; private mediation keeps its own provider. */
export async function generateMeetingJson(prompt: string, options: Options = {}): Promise<unknown> {
  const provider = process.env.MEETING_MODEL_PROVIDER?.trim() || "gemini";
  if (provider === "gemini") return generateJson(prompt, undefined, options);
  if (provider !== "siliconflow") throw new Error("Unknown meeting model provider.");
  const apiKey = process.env.SILICONFLOW_API_KEY?.trim();
  const model = process.env.SILICONFLOW_MODEL?.trim() || "Qwen/Qwen3.5-4B";
  if (!apiKey) throw new Error("SiliconFlow configuration is missing.");
  const timeout = AbortSignal.timeout(options.timeoutMs ?? 25_000);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  const response = await fetch("https://api.siliconflow.cn/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model, messages: [{ role: "user", content: prompt }],
      response_format: { type: "json_object" }, enable_thinking: false,
      temperature: options.temperature ?? 0.2, max_tokens: 8192, stream: false }),
    signal,
  });
  // Do not expose provider bodies: they may echo prompts or credentials.
  if (!response.ok) throw new Error(`SiliconFlow request failed (HTTP ${response.status}).`);
  let payload;
  try { payload = await response.json(); }
  catch { throw new Error("SiliconFlow returned invalid JSON."); }
  const choice = payload?.choices?.[0];
  if (choice?.finish_reason !== "stop") throw new Error("SiliconFlow returned incomplete content.");
  const content = choice?.message?.content;
  if (typeof content !== "string" || !content.trim()) throw new Error("SiliconFlow returned empty content.");
  try { return JSON.parse(content); }
  catch { throw new Error("SiliconFlow returned invalid JSON content."); }
}
