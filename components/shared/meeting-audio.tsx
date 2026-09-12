"use client";

import { useEffect, useState, type ReactNode } from "react";
import {
  LiveKitRoom, RoomAudioRenderer, StartAudio, useRoomContext, type LiveKitRoomProps,
} from "@livekit/components-react";
import { AudioPresets, type RoomOptions } from "livekit-client";
import type { LiveKitConnection } from "@/contracts/media";
import { MeetingMediaLifecycleContext } from "@/hooks/use-meeting-audio";
import { MeetingMediaLifecycle } from "@/lib/media/meeting-media-lifecycle";
import "@livekit/components-styles";

const AUDIO_OPTIONS: RoomOptions = {
  audioCaptureDefaults: {
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
    channelCount: 1,
  },
  publishDefaults: { audioPreset: AudioPresets.speech },
  stopLocalTrackOnUnpublish: true,
};

function LocalMediaOwner({ children }: { children: ReactNode }) {
  const room = useRoomContext();
  const [lifecycle] = useState(() => new MeetingMediaLifecycle(() => {
    for (const publication of room.localParticipant.trackPublications.values()) {
      publication.track?.stop();
    }
  }));
  useEffect(() => {
    lifecycle.activate();
    return () => {
      lifecycle.stop();
      // LiveKitRoom also disconnects; explicitly preserve stopTracks=true here.
      void room.disconnect(true);
    };
  }, [lifecycle, room]);
  return <MeetingMediaLifecycleContext.Provider value={lifecycle}>
    {children}
  </MeetingMediaLifecycleContext.Provider>;
}

export type MeetingAudioProps = {
  /** Connection returned by the authenticated join/token business flow. */
  connection: LiveKitConnection | null;
  /** Set false when leaving, ending, or entering media isolation. */
  enabled?: boolean;
  children?: ReactNode;
  onConnected?: LiveKitRoomProps["onConnected"];
  onDisconnected?: LiveKitRoomProps["onDisconnected"];
  onError?: LiveKitRoomProps["onError"];
  onMediaDeviceFailure?: LiveKitRoomProps["onMediaDeviceFailure"];
};

/** Single shared audio/video provider. Device capture remains explicitly opt-in. */
export function MeetingAudio({
  connection, enabled = true, children, ...events
}: MeetingAudioProps) {
  // Unmount the SDK room to stop tracks and disconnect on exit/isolation.
  if (!enabled || !connection) return null;
  return <LiveKitRoom
    key={`${connection.serverUrl}:${connection.roomName}:${connection.participantIdentity}`}
    serverUrl={connection.serverUrl}
    token={connection.participantToken}
    options={AUDIO_OPTIONS}
    connect
    audio={false}
    video={false}
    data-lk-theme="default"
    {...events}
  >
    <LocalMediaOwner>{children}</LocalMediaOwner>
    <RoomAudioRenderer />
    <StartAudio label="Enable meeting audio" />
  </LiveKitRoom>;
}
