type ReportRow = {
  id?: string;
  type?: string;
  kind?: string;
  mediaType?: string;
  codecId?: string;
  mimeType?: string;
  remoteId?: string;
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
