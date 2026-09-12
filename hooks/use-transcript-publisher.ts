"use client";

import { useCallback, useState } from "react";
import { useRoomContext } from "@livekit/components-react";
import { TRANSCRIPT_DATA_TOPIC, type TranscriptPacket } from "../contracts/transcript-packet";

export type UseTranscriptPublisherOptions = {
  /** The participant's current consent revision, supplied by the meeting page. */
  consentRevision: number;
  language?: string;
};

/** Publishes browser-final transcripts as reliable data on the reserved topic. */
export function useTranscriptPublisher({ consentRevision, language }: UseTranscriptPublisherOptions) {
  const room = useRoomContext();
  const [streamId] = useState(() => crypto.randomUUID());

  const publishFinal = useCallback((text: string) => {
    const content = text.trim();
    if (!content) return;
    const browserLanguage = typeof navigator !== "undefined" ? navigator.language : "";
    const packet: TranscriptPacket = {
      segmentId: crypto.randomUUID(),
      streamId,
      revision: 1,
      content,
      startedAtMs: null,
      endedAtMs: null,
      language: language || browserLanguage || null,
      confidence: null,
      consentRevision,
      recognizedAt: new Date().toISOString(),
    };
    void room.localParticipant.publishData(new TextEncoder().encode(JSON.stringify(packet)), {
      reliable: true,
      topic: TRANSCRIPT_DATA_TOPIC,
    });
  }, [room, streamId, consentRevision, language]);

  return { publishFinal };
}
