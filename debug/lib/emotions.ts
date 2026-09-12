export type EmotionScore = { name: string; score: number };
export type EmotionObservation = {
  type: "observation"; text: string; interim: boolean;
  startMs: number | null; endMs: number | null; receivedAt: string;
  scores: EmotionScore[];
};

// Keep scores separate: they are not probabilities that sum to one or node intensity.
export function parseEmotionMessage(value: unknown): EmotionObservation | null {
  if (!value || typeof value !== "object") return null;
  const event = value as Record<string, unknown>;
  if (event.type !== "user_message" || event.from_text !== false) return null;
  const models = event.models as { prosody?: { scores?: unknown } } | undefined;
  const raw = models?.prosody?.scores;
  const scores = raw && typeof raw === "object" && !Array.isArray(raw)
    ? Object.entries(raw).filter(([name, score]) => name.length <= 80 && typeof score === "number" && Number.isFinite(score) && score >= 0 && score <= 1)
      .map(([name, score]) => ({ name, score: score as number })).sort((a, b) => b.score - a.score)
    : [];
  const time = event.time as { begin?: unknown; end?: unknown } | undefined;
  const message = event.message as { content?: unknown } | undefined;
  return {
    type: "observation", text: typeof message?.content === "string" ? message.content.slice(0,4000) : "",
    interim: event.interim === true,
    startMs: typeof time?.begin === "number" && Number.isFinite(time.begin) ? time.begin : null,
    endMs: typeof time?.end === "number" && Number.isFinite(time.end) ? time.end : null,
    receivedAt: new Date().toISOString(), scores,
  };
}

export function isEmotionOrigin(origin: string | undefined, host: string | undefined): boolean {
  try {
    const url = new URL(origin ?? "");
    return url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname)
      && url.port === "3001" && origin === url.origin
      && ["127.0.0.1:3002", "localhost:3002"].includes(host ?? "");
  } catch { return false; }
}
