import { GoogleGenAI } from "@google/genai";

export type GeminiConfig = { apiKey: string; model: string };

export function readGeminiConfig(): GeminiConfig {
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  const model = process.env.GEMINI_MODEL?.trim() || "gemini-3.6-flash";
  if (!apiKey) throw new Error("Gemini configuration is missing.");
  return { apiKey, model };
}

/** Injectable model shape; production uses the Gemini REST SDK under the hood. */
export type JsonModel = (prompt: string) => Promise<unknown>;

export async function generateJson(
  prompt: string,
  config: GeminiConfig = readGeminiConfig(),
  options: { temperature?: number; timeoutMs?: number } = {},
): Promise<unknown> {
  const ai = new GoogleGenAI({ apiKey: config.apiKey });
  const signal = options.timeoutMs ? AbortSignal.timeout(options.timeoutMs) : undefined;
  const response = await ai.models.generateContent({
    model: config.model,
    contents: prompt,
    config: { responseMimeType: "application/json", temperature: options.temperature ?? 0.2 },
    ...(signal ? { signal } : {}),
  });
  const text = response.text;
  if (!text) throw new Error("Gemini returned empty content.");
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("Gemini returned invalid JSON.");
  }
}
