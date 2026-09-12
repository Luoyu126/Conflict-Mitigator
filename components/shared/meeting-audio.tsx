"use client";

import type { ReactNode } from "react";
import {
  LiveKitRoom, RoomAudioRenderer, StartAudio, type LiveKitRoomProps,
} from "@livekit/components-react";
import { AudioPresets, type RoomOptions } from "livekit-client";
import type { LiveKitConnection } from "@/contracts/media";
import "@livekit/components-styles";

const AUDIO_OPTIONS: RoomOptions = {
  audioCaptureDefaults: {
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
    channelCount: 1,
  },
  publishDefaults: { audioPreset: AudioPresets.speech },
};

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

/** Media-only provider. Does not join business rooms or change their state. */
export function MeetingAudio({
  connection, enabled = true, children, ...events
}: MeetingAudioProps) {
  // Unmount the SDK room to stop tracks and disconnect on exit/isolation.
  if (!enabled || !connection) return null;
  return <LiveKitRoom
    key={`${connection.roomName}:${connection.participantIdentity}`}
    serverUrl={connection.serverUrl}
    token={connection.participantToken}
    options={AUDIO_OPTIONS}
    connect
    audio={false}
    video={false}
    data-lk-theme="default"
    {...events}
  >
    {children}
    <RoomAudioRenderer />
    <StartAudio label="点击开启会议声音" />
  </LiveKitRoom>;
}
