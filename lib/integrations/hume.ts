import "server-only";

import WebSocket from "ws";
import { parseVoiceAffect, unavailableVoiceAffect, type VoiceAffectResult } from "../affect/voice.ts";

export type HumeStreamOptions = {
  sampleRate: number;
  signal: AbortSignal;
  onResult: (result: VoiceAffectResult) => void;
  onError?: (error: Error) => void;
};
export type HumeStream = { write: (pcm: Int16Array) => boolean; close: () => void };
export type HumeSocket = {
  readyState: number;
  bufferedAmount: number;
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  send(data: string): void;
  terminate(): void;
};
type SocketOptions = { headers: Record<string, string>; handshakeTimeout: number; maxPayload: number };
/** Dependency injection is server-side only, for offline protocol tests. */
export type HumeStreamDependencies = {
  createSocket?: (url: string, options: SocketOptions) => HumeSocket;
  config?: { apiKey: string; configId?: string };
  readyTimeoutMs?: number;
  idleTimeoutMs?: number;
  maxDurationMs?: number;
};

const MAX_BUFFERED_BYTES = 256_000;
const MAX_INBOUND_BYTES = 2 * 1024 * 1024;

/**
 * Streams existing Worker-owned mono PCM, with no browser microphone or text ingestion.
 * False means this frame was not accepted; callers must drop it rather than queue old audio.
 * Clean close/abort is silent. Failures deliver one unavailable observation and one safe error.
 */
export function createHumeStream(options: HumeStreamOptions, dependencies: HumeStreamDependencies = {}): HumeStream {
  let socket: HumeSocket | undefined;
  let finished = false;
  let ready = false;
  let readyTimer: ReturnType<typeof setTimeout> | undefined = undefined;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let durationTimer: ReturnType<typeof setTimeout> | undefined = undefined;
  let windowStart = Date.now();
  let bytesInWindow = 0;

  const dispose = () => {
    if (finished) return;
    finished = true; ready = false;
    clearTimeout(readyTimer); clearTimeout(idleTimer); clearTimeout(durationTimer);
    options.signal.removeEventListener("abort", dispose);
    socket?.terminate();
  };
  const fail = (message: string) => {
    if (finished) return;
    dispose();
    options.onResult(unavailableVoiceAffect());
    options.onError?.(new Error(message));
  };
  const resetIdle = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => fail("Voice analysis audio stream stopped."), dependencies.idleTimeoutMs ?? 15_000);
    idleTimer.unref?.();
  };
  const stream: HumeStream = {
    close: dispose,
    write(pcm) {
      if (finished || !ready || !socket || socket.readyState !== WebSocket.OPEN) return false;
      if (!(pcm instanceof Int16Array) || pcm.length === 0 || pcm.length > options.sampleRate) {
        fail("Voice analysis received invalid PCM audio."); return false;
      }
      if (Date.now() - windowStart >= 1000) { windowStart = Date.now(); bytesInWindow = 0; }
      bytesInWindow += pcm.byteLength;
      if (bytesInWindow > options.sampleRate * 2 * 3 || socket.bufferedAmount > MAX_BUFFERED_BYTES) {
        fail("Voice analysis stopped because audio transmission was backlogged."); return false;
      }
      const bytes = Buffer.allocUnsafe(pcm.byteLength);
      for (let i = 0; i < pcm.length; i++) bytes.writeInt16LE(pcm[i], i * 2);
      try {
        socket.send(JSON.stringify({ type: "audio_input", data: bytes.toString("base64") }));
        resetIdle();
        return true;
      } catch {
        fail("Voice analysis audio transmission failed."); return false;
      }
    },
  };

  if (options.signal.aborted) { dispose(); return stream; }
  options.signal.addEventListener("abort", dispose, { once: true });
  if (!Number.isInteger(options.sampleRate) || options.sampleRate < 8_000 || options.sampleRate > 96_000) {
    fail("Voice analysis requires a supported PCM sample rate."); return stream;
  }
  const config = dependencies.config ?? {
    apiKey: process.env.HUME_API_KEY?.trim() ?? "",
    configId: process.env.HUME_CONFIG_ID?.trim(),
  };
  if (!config.apiKey) { fail("Voice analysis is not configured."); return stream; }
  const endpoint = new URL("wss://api.hume.ai/v0/evi/chat");
  endpoint.searchParams.set("verbose_transcription", "true");
  if (config.configId) endpoint.searchParams.set("config_id", config.configId);
  try {
    socket = dependencies.createSocket
      ? dependencies.createSocket(endpoint.toString(), { headers: { "X-Hume-Api-Key": config.apiKey }, handshakeTimeout: 10_000, maxPayload: MAX_INBOUND_BYTES })
      : new WebSocket(endpoint, { headers: { "X-Hume-Api-Key": config.apiKey }, handshakeTimeout: 10_000, maxPayload: MAX_INBOUND_BYTES });
  } catch {
    fail("Voice analysis could not connect to its provider."); return stream;
  }
  readyTimer = setTimeout(() => fail("Voice analysis provider readiness timed out."), dependencies.readyTimeoutMs ?? 15_000);
  durationTimer = setTimeout(() => fail("Voice analysis stream reached its duration limit."), dependencies.maxDurationMs ?? 300_000);
  readyTimer.unref?.(); durationTimer.unref?.();
  socket.on("open", () => {
    if (finished) return;
    try {
      socket!.send(JSON.stringify({ type: "session_settings", audio: { encoding: "linear16", sample_rate: options.sampleRate, channels: 1 } }));
    } catch { fail("Voice analysis provider initialization failed."); }
  });
  socket.on("message", raw => {
    if (finished) return;
    let text: string;
    if (typeof raw === "string") text = raw;
    else if (Buffer.isBuffer(raw)) text = raw.toString("utf8");
    else { fail("Voice analysis provider returned an invalid message."); return; }
    if (Buffer.byteLength(text) > MAX_INBOUND_BYTES) { fail("Voice analysis provider returned an oversized message."); return; }
    let event: unknown;
    try { event = JSON.parse(text); } catch { fail("Voice analysis provider returned invalid JSON."); return; }
    if (!event || typeof event !== "object" || Array.isArray(event)) { fail("Voice analysis provider returned an invalid event."); return; }
    const type = (event as Record<string, unknown>).type;
    if (type === "error") { fail("Voice analysis provider rejected this stream."); return; }
    if (type === "chat_metadata") {
      if (!ready) { ready = true; clearTimeout(readyTimer); resetIdle(); }
      return;
    }
    if (!ready) return;
    const result = parseVoiceAffect(event);
    if (result) options.onResult(result);
    // Assistant audio, transcript strings, chat metadata and identifiers never leave this module.
  });
  socket.on("unexpected-response", (_request, response) => {
    if (response && typeof response === "object" && "resume" in response && typeof response.resume === "function") response.resume();
    fail("Voice analysis provider rejected the connection.");
  });
  socket.on("error", () => fail("Voice analysis provider connection failed."));
  socket.on("close", () => fail("Voice analysis provider disconnected."));
  return stream;
}
