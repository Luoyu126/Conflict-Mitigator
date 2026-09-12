"use client";

import { createContext, useCallback, useContext } from "react";
import { useConnectionState, useLocalParticipant, useRoomContext } from "@livekit/components-react";
import { ConnectionState } from "livekit-client";
import type { MeetingMediaLifecycle } from "@/lib/media/meeting-media-lifecycle";

export const MeetingMediaLifecycleContext = createContext<MeetingMediaLifecycle | null>(null);

/** Shared owner for camera, microphone and emotion modules; never opens a device. */
export function useMeetingMedia() {
  const room = useRoomContext();
  const lifecycle = useContext(MeetingMediaLifecycleContext);
  const connectionState = useConnectionState();
  const participant = useLocalParticipant();
  if (!lifecycle) throw new Error("Meeting media hooks must be used inside MeetingAudio.");

  const runMediaOperation = useCallback(<T,>(operation: () => Promise<T>) => {
    return lifecycle.run(async () => {
      if (room.state !== ConnectionState.Connected) {
        throw new Error("Connect to the meeting before changing media devices.");
      }
      return operation();
    });
  }, [lifecycle, room]);

  const disconnectMedia = useCallback(() => {
    lifecycle.stop();
    return room.disconnect(true);
  }, [lifecycle, room]);

  return { room, connectionState, ...participant, runMediaOperation, disconnectMedia };
}

/** Use inside MeetingAudio; operations reject on SDK/device errors for the UI to handle. */
export function useMeetingAudio() {
  const { room, connectionState, localParticipant, isMicrophoneEnabled,
    microphoneTrack, lastMicrophoneError, runMediaOperation, disconnectMedia } = useMeetingMedia();

  const setMicrophoneEnabled = useCallback(async (enabled: boolean) => {
    await runMediaOperation(() => localParticipant.setMicrophoneEnabled(enabled));
  }, [localParticipant, runMediaOperation]);

  const selectMicrophone = useCallback(async (deviceId: string) => {
    if (!deviceId.trim()) throw new Error("Select a microphone device.");
    return runMediaOperation(() => room.switchActiveDevice("audioinput", deviceId));
  }, [room, runMediaOperation]);

  const startAudioPlayback = useCallback(() => room.startAudio(), [room]);

  return {
    connectionState,
    isMicrophoneEnabled,
    microphoneTrack,
    localAudioTrack: microphoneTrack?.track,
    lastMicrophoneError,
    setMicrophoneEnabled,
    selectMicrophone,
    startAudioPlayback,
    disconnectMedia,
  };
}
