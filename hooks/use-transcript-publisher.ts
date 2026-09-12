"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { useRoomContext } from "@livekit/components-react";
import { ConnectionState } from "livekit-client";
import { TRANSCRIPT_DATA_TOPIC, type TranscriptPacket } from "@/contracts/transcript-packet";

export function useTranscriptPublisher({ consentRevision, enabled, language }: {
  consentRevision: number; enabled: boolean; language?: string;
}) {
  const room = useRoomContext();
  const [streamId] = useState(() => crypto.randomUUID());
  const [error, setError] = useState("");
  const active = useRef(false);
  useEffect(() => { active.current = enabled; return () => { active.current = false; }; }, [enabled, consentRevision]);
  const publishFinal = useCallback((text: string) => {
    const content = text.trim();
    if (!content || !enabled || !active.current || room.state !== ConnectionState.Connected || !room.localParticipant.isMicrophoneEnabled) return;
    const packet: TranscriptPacket = { segmentId: crypto.randomUUID(), streamId, revision: 1, content,
      startedAtMs: null, endedAtMs: null, language: language || navigator.language || null,
      confidence: null, consentRevision, recognizedAt: new Date().toISOString() };
    void room.localParticipant.publishData(new TextEncoder().encode(JSON.stringify(packet)), {
      reliable: true, topic: TRANSCRIPT_DATA_TOPIC,
    }).catch(() => { if (active.current) setError("The transcript could not be delivered. Check your meeting connection."); });
  }, [room, streamId, consentRevision, language, enabled]);
  return { publishFinal, error };
}
