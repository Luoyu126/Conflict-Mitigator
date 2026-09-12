type ReportRow = {
  id?: string;
  type?: string;
  kind?: string;
  mediaType?: string;
  codecId?: string;
  mimeType?: string;
  remoteId?: string;
  frameWidth?: number;
  frameHeight?: number;
  framesPerSecond?: number;
  framesDropped?: number;
  totalDecodeTime?: number;
  framesDecoded?: number;
  roundTripTime?: number;
  jitter?: number;
  packetsLost?: number;
  packetsReceived?: number;
  jitterBufferDelay?: number;
  jitterBufferEmittedCount?: number;
};

export type AudioMetrics = {
  rttMs?: number;
  jitterMs?: number;
  lostPackets?: number;
  receivedPackets?: number;
  bufferMeanMs?: number;
  codec?: string;
  width?: number;
  height?: number;
  fps?: number;
  framesDropped?: number;
  decodeMeanMs?: number;
};

// Values absent from the browser report stay absent; never substitute zero.
export function summarizeAudioReport(rows: ReportRow[]): AudioMetrics {
  const audio = rows.find((row) => row.type === "inbound-rtp" && (row.kind === "audio" || row.mediaType === "audio"))
    ?? rows.find((row) => row.type === "outbound-rtp" && (row.kind === "audio" || row.mediaType === "audio"));
  if (!audio) return {};
  const remote = audio.remoteId ? rows.find((row) => row.id === audio.remoteId) : undefined;
  const jitter = audio.jitter ?? remote?.jitter;
  return {
    rttMs: remote?.roundTripTime == null ? undefined : remote.roundTripTime * 1000,
    jitterMs: jitter == null ? undefined : jitter * 1000,
    lostPackets: audio.packetsLost ?? remote?.packetsLost,
    receivedPackets: audio.packetsReceived,
    bufferMeanMs: audio.jitterBufferDelay != null && audio.jitterBufferEmittedCount != null && audio.jitterBufferEmittedCount > 0
      ? audio.jitterBufferDelay / audio.jitterBufferEmittedCount * 1000 : undefined,
    codec: audio.codecId ? rows.find((row) => row.id === audio.codecId)?.mimeType : undefined,
  };
}

// Keep simulcast layers separate; each outbound SSRC has its own dimensions and RTT.
export function summarizeVideoReport(rows: ReportRow[]): AudioMetrics[] {
  return rows.filter((row) => ["inbound-rtp", "outbound-rtp"].includes(row.type ?? "")
    && (row.kind === "video" || row.mediaType === "video")).map((video) => {
    const common = summarizeAudioReport([
      ...rows.filter((row) => !["inbound-rtp", "outbound-rtp"].includes(row.type ?? "")),
      { ...video, kind: "audio", mediaType: "audio" },
    ]);
    return { ...common, width: video.frameWidth, height: video.frameHeight,
      fps: video.framesPerSecond, framesDropped: video.framesDropped,
      decodeMeanMs: video.totalDecodeTime != null && video.framesDecoded != null && video.framesDecoded > 0
        ? video.totalDecodeTime / video.framesDecoded * 1000 : undefined,
    };
  });
}
