"use client";

import { useCallback } from "react";
import { useConnectionState, useLocalParticipant, useRoomContext } from "@livekit/components-react";

/** Use inside MeetingAudio; operations reject on SDK/device errors for the UI to handle. */
export function useMeetingAudio() {
  const room = useRoomContext();
  const connectionState = useConnectionState();
  const { localParticipant, isMicrophoneEnabled, microphoneTrack, lastMicrophoneError } = useLocalParticipant();

  const setMicrophoneEnabled = useCallback(async (enabled: boolean) => {
    await localParticipant.setMicrophoneEnabled(enabled);
  }, [localParticipant]);

  const selectMicrophone = useCallback(async (deviceId: string) => {
    return room.switchActiveDevice("audioinput", deviceId);
  }, [room]);

  const startAudioPlayback = useCallback(() => room.startAudio(), [room]);

  // Only disconnects media; the caller must also execute API-07/08 as needed.
  const disconnectMedia = useCallback(() => room.disconnect(true), [room]);

  return {
    connectionState,
    isMicrophoneEnabled,
    microphoneTrack,
    lastMicrophoneError,
    setMicrophoneEnabled,
    selectMicrophone,
    startAudioPlayback,
    disconnectMedia,
  };
}
