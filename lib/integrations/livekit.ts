import "server-only";

import { AccessToken, TrackSource } from "livekit-server-sdk";
import type { LiveKitConnection } from "../../contracts/media";

export type LiveKitConfig = {
  serverUrl: string;
  apiKey: string;
  apiSecret: string;
};

export type AudioConnectionInput = {
  /** Persisted rooms.id, supplied by the authorized server-side caller. */
  roomId: string;
  /** Persisted participants.id belonging to the authenticated subject. */
  participantId: string;
  displayName: string;
  /** Token lifetime, not a timer that disconnects an established call. */
  ttlSeconds?: number;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function serverUrl(value: string): string {
  try {
    const url = new URL(value);
    if (url.protocol !== "wss:" || url.username || url.password || url.search || url.hash) {
      throw new Error();
    }
    return url.toString();
  } catch {
    // Do not include configured values in an error or a log.
    throw new Error("Invalid LiveKit server URL.");
  }
}

export function readLiveKitConfig(): LiveKitConfig {
  const { LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET } = process.env;
  if (!LIVEKIT_URL || !LIVEKIT_API_KEY?.trim() || !LIVEKIT_API_SECRET?.trim()) {
    throw new Error("LiveKit server configuration is missing.");
  }
  return {
    serverUrl: serverUrl(LIVEKIT_URL),
    apiKey: LIVEKIT_API_KEY,
    apiSecret: LIVEKIT_API_SECRET,
  };
}

/**
 * Low-level SDK adapter, NOT an authorization service or an HTTP endpoint.
 * Before calling, the business service must verify auth subject/membership,
 * room status, mediation isolation and token revocation cutoff, and persist
 * mediaEpochAt when issuing the first connection (see API-04/05).
 * Never pass browser-selected participant identities or grant objects here.
 */
export async function createLiveKitAudioConnection(
  input: AudioConnectionInput,
  config: LiveKitConfig = readLiveKitConfig(),
): Promise<LiveKitConnection> {
  if (!UUID.test(input.roomId) || !UUID.test(input.participantId)) {
    throw new Error("A persisted room UUID and participant UUID are required.");
  }
  const name = input.displayName.trim();
  if (!name || name.length > 40) throw new Error("Invalid participant display name.");
  const ttl = input.ttlSeconds ?? 600;
  if (!Number.isSafeInteger(ttl) || ttl <= 0) throw new Error("Invalid token lifetime.");
  if (!config.apiKey.trim() || !config.apiSecret.trim()) {
    throw new Error("LiveKit server configuration is missing.");
  }
  const url = serverUrl(config.serverUrl);
  const roomName = `cm_${input.roomId}`;
  const token = new AccessToken(config.apiKey, config.apiSecret, {
    identity: input.participantId, name, ttl,
  });
  token.addGrant({
    roomJoin: true,
    room: roomName,
    canSubscribe: true,
    canPublish: true,
    canPublishSources: [TrackSource.MICROPHONE],
    // Enabled only so the browser can publish browser-confirmed final speech
    // recognition results on the reserved topic `cm.transcript.final.v1`
    // (see docs/api/decision-overrides-v0.2.md §2). This grants no camera,
    // screen-share, metadata-update, or room-admin capability.
    canPublishData: true,
    canUpdateOwnMetadata: false,
  });
  const participantToken = await token.toJwt();
  // Read exp from the JWT just created by our SDK, so the DTO cannot drift
  // from the SDK's signing timestamp. This is not verification of client JWTs.
  const { exp } = JSON.parse(Buffer.from(participantToken.split(".")[1], "base64url").toString("utf8")) as { exp: number };
  return {
    serverUrl: url,
    participantToken,
    roomName,
    participantIdentity: input.participantId,
    expiresAt: new Date(exp * 1000).toISOString(),
  };
}
