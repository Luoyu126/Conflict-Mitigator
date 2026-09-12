import { Room, RoomEvent, TrackSource, DataPacketKind, AudioStream, VideoStream, VideoBufferType, type RemoteTrackPublication, type RemoteParticipant } from "@livekit/rtc-node";
import { AccessToken, RoomServiceClient } from "livekit-server-sdk";
import sharp from "sharp";
import { readLiveKitConfig } from "../lib/integrations/livekit.ts";
import { bounded, type WorkerMedia, type MediaAdmin, type Publication } from "./media-types.ts";

export async function createObserverToken(roomId: string, runId: string, config = readLiveKitConfig()): Promise<string> {
  const token = new AccessToken(config.apiKey, config.apiSecret, { identity: `observer_${runId}`, ttl: 600 });
  token.addGrant({ roomJoin: true, room: `cm_${roomId}`, canSubscribe: true, canPublish: false, canPublishData: false,
    canUpdateOwnMetadata: false, hidden: true });
  return token.toJwt();
}
export function createNativeMedia(roomId: string, runId: string, config = readLiveKitConfig()): WorkerMedia {
  const room = new Room();
  const wraps = new Map<string, { publication: RemoteTrackPublication; wrapper: Publication }>();
  let change = () => {};
  let data: Parameters<WorkerMedia["onData"]>[0] = () => {};
  const refresh = () => {
    const present = new Set<string>();
    for (const participant of room.remoteParticipants.values()) for (const publication of participant.trackPublications.values()) {
      if (!publication.sid || !participant.identity) continue;
      present.add(publication.sid);
      const wrapper: Publication = {
        identity: participant.identity, sid: publication.sid,
        source: publication.source === TrackSource.SOURCE_MICROPHONE ? "microphone" : publication.source === TrackSource.SOURCE_CAMERA ? "camera" : "other",
        muted: publication.muted === true, subscribed: publication.subscribed && Boolean(publication.track),
        subscribe: value => publication.setSubscribed(value),
      };
      wraps.set(publication.sid, { publication, wrapper });
    }
    for (const sid of wraps.keys()) if (!present.has(sid)) wraps.delete(sid);
    change();
  };
  for (const name of [RoomEvent.TrackPublished, RoomEvent.TrackUnpublished, RoomEvent.TrackSubscribed, RoomEvent.TrackUnsubscribed,
    RoomEvent.TrackMuted, RoomEvent.TrackUnmuted, RoomEvent.ParticipantDisconnected, RoomEvent.Reconnected]) room.on(name, refresh);
  room.on(RoomEvent.Disconnected, () => { wraps.clear(); change(); });
  room.on(RoomEvent.DataReceived, (payload: Uint8Array, participant?: RemoteParticipant, kind?: DataPacketKind, topic?: string) => data(payload, participant?.identity, kind === DataPacketKind.KIND_RELIABLE, topic));
  async function drain<T>(stream: ReadableStream<T>, signal: AbortSignal, onFrame: (frame: T) => void): Promise<void> {
    const reader = stream.getReader();
    const abort = () => { void reader.cancel().catch(() => {}); };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    try {
      while (!signal.aborted) { const next = await reader.read(); if (next.done) break; onFrame(next.value); }
    } finally { signal.removeEventListener("abort", abort); await reader.cancel().catch(() => {}); reader.releaseLock(); }
  }
  return {
    onChange(callback) { change = callback; }, onData(callback) { data = callback; },
    publications: () => [...wraps.values()].map(item => item.wrapper),
    async connect(signal) {
      const abort = () => { void room.disconnect().catch(() => {}); };
      signal.addEventListener("abort", abort, { once: true });
      try {
        await bounded(room.connect(config.serverUrl, await createObserverToken(roomId, runId, config), {
          autoSubscribe: false, dynacast: true, dataStream: { maxPayloadByteLength: 32 * 1024 },
        }), signal);
        signal.throwIfAborted(); refresh();
      } catch (error) { await room.disconnect().catch(() => {}); throw error; }
      finally { signal.removeEventListener("abort", abort); }
    },
    close: () => room.disconnect(),
    isConnected: () => room.isConnected,
    async audio(publication, signal, onFrame) {
      const track = wraps.get(publication.sid)?.publication.track;
      if (!track) return;
      await drain(new AudioStream(track, { sampleRate: 24_000, numChannels: 1, frameSizeMs: 100 }), signal, frame => onFrame(frame.data));
    },
    async video(publication, signal, onFrame) {
      const track = wraps.get(publication.sid)?.publication.track;
      if (!track) return;
      await drain(new VideoStream(track), signal, event => {
        const receivedAt = Date.now();
        onFrame({ timestampUs: event.timestampUs.toString(), receivedAt, async encode() {
          if (!Number.isInteger(event.rotation) || event.rotation < 0 || event.rotation > 3 || event.frame.width * event.frame.height > 16_777_216) throw new Error("Invalid camera frame.");
          const rgb = event.frame.convert(VideoBufferType.RGB24);
          const image = sharp(rgb.data, { raw: { width: rgb.width, height: rgb.height, channels: 3 } })
            .rotate(event.rotation * 90).resize({ width: 640, height: 640, fit: "inside", withoutEnlargement: true });
          const { data: jpeg, info } = await image.jpeg({ quality: 75 }).toBuffer({ resolveWithObject: true });
          if (jpeg.byteLength > 524_288) throw new Error("Camera frame exceeds size limit.");
          return { jpeg, width: info.width, height: info.height };
        } });
      });
    },
  };
}
export function createMediaAdmin(roomId: string, config = readLiveKitConfig()): MediaAdmin {
  const url = new URL(config.serverUrl); url.protocol = "https:";
  const client = new RoomServiceClient(url.origin, config.apiKey, config.apiSecret, { requestTimeout: 10, failover: false });
  async function idempotent(operation: Promise<unknown>, signal: AbortSignal) {
    try { await bounded(operation, signal); }
    catch (error) {
      // Only an explicit not-found result is idempotent success, never generic HTTP failures.
      if (!(error && typeof error === "object" && "code" in error && error.code === "not_found")) throw error;
    }
  }
  return {
    remove: (identity, cutoff, signal) => idempotent(client.removeParticipant(`cm_${roomId}`, identity, { revokeTokenTs: BigInt(cutoff) }), signal),
    deleteRoom: signal => idempotent(client.deleteRoom(`cm_${roomId}`), signal),
  };
}
