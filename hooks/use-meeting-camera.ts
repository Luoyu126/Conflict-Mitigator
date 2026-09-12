"use client";

import { useCallback } from "react";
import { useMeetingMedia } from "@/hooks/use-meeting-audio";

/** Uses the meeting's existing Room and camera publication, including for sampling. */
export function useMeetingCamera() {
  const { room, connectionState, localParticipant, isCameraEnabled,
    cameraTrack, lastCameraError, runMediaOperation } = useMeetingMedia();

  const setCameraEnabled = useCallback(async (enabled: boolean) => {
    await runMediaOperation(() => localParticipant.setCameraEnabled(enabled));
  }, [localParticipant, runMediaOperation]);

  const selectCamera = useCallback(async (deviceId: string) => {
    if (!deviceId.trim()) throw new Error("Select a camera device.");
    return runMediaOperation(() => room.switchActiveDevice("videoinput", deviceId));
  }, [room, runMediaOperation]);

  return { connectionState, isCameraEnabled, cameraTrack,
    localVideoTrack: cameraTrack?.track, lastCameraError, setCameraEnabled, selectCamera };
}
