import { randomUUID } from "node:crypto";
import { AccessToken, TrackSource } from "livekit-server-sdk";

export function validateJoin(value: unknown): { room: string; name: string } | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const fields = value as Record<string, unknown>;
  if (Object.keys(fields).some((key) => !["room", "name"].includes(key))) return null;
  if (typeof fields.room !== "string" || typeof fields.name !== "string") return null;
  const room = fields.room.trim();
  const name = fields.name.trim();
  if (!/^[a-zA-Z0-9_-]{1,48}$/.test(room) || !name || name.length > 40) return null;
  return { room, name };
}

export function isLocalRequest(request: Request): boolean {
  const url = new URL(request.url);
  const localHosts = ["localhost", "127.0.0.1", "[::1]"];
  const host = request.headers.get("host");
  const origin = request.headers.get("origin");
  if (!host || !origin) return false;
  try {
    // Next.js may normalize request.url to localhost even for 127.0.0.1.
    // Compare the browser Origin to the original Host, not that normalized host.
    const source = new URL(origin);
    return localHosts.includes(url.hostname)
      && localHosts.includes(source.hostname)
      && source.host === host
      && source.port === url.port
      && source.protocol === url.protocol
      && source.origin === origin;
  } catch { return false; }
}

export async function issueDebugToken(
  input: { room: string; name: string },
  config: { url: string; key: string; secret: string },
) {
  const url = new URL(config.url);
  if (url.protocol !== "wss:" || url.username || url.password) {
    throw new Error("Invalid LiveKit URL");
  }
  const roomName = `debug-audio-${input.room}`;
  const identity = `debug-${randomUUID()}`;
  const token = new AccessToken(config.key, config.secret, {
    identity, name: input.name, ttl: "10m",
  });
  token.addGrant({
    roomJoin: true, room: roomName, canSubscribe: true,
    canPublish: true, canPublishSources: [TrackSource.MICROPHONE, TrackSource.CAMERA],
    canPublishData: false, canUpdateOwnMetadata: false,
  });
  return { serverUrl: url.toString(), participantToken: await token.toJwt(), roomName, identity };
}
