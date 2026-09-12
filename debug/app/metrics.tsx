"use client";

import { useEffect, useState } from "react";
import { useConnectionState, useRoomContext } from "@livekit/components-react";
import { Track } from "livekit-client";
import { summarizeAudioReport, type AudioMetrics } from "../lib/stats";

type MetricRow = AudioMetrics & {
  name: string;
  direction: string;
  bitrateKbps: number;
};

const format = (n?: number) => n == null || !Number.isFinite(n) ? "—" : n.toFixed(1);

export default function Metrics({ connectionMs }: { connectionMs: number | null }) {
  const room = useRoomContext();
  const connection = useConnectionState();
  const [snapshot, setSnapshot] = useState<{ rows: MetricRow[]; settings?: MediaTrackSettings; at?: string }>({ rows: [] });
  const [unavailable, setUnavailable] = useState(false);

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    async function sample() {
      try {
        const participants = [room.localParticipant, ...room.remoteParticipants.values()];
        const rows = (await Promise.all(participants.flatMap((p) => [...p.audioTrackPublications.values()].map(async (publication) => {
          const track = publication.track;
          if (!track) return null;
          const report = await track.getRTCStatsReport();
          const entries: Parameters<typeof summarizeAudioReport>[0] = [];
          report?.forEach((entry) => entries.push(entry));
          return {
            ...summarizeAudioReport(entries), name: p.name || p.identity,
            direction: p.isLocal ? "本机发送" : "本机接收",
            bitrateKbps: track.currentBitrate / 1000,
          };
        })))).filter((row): row is MetricRow => row !== null);
        const settings = room.localParticipant.getTrackPublication(Track.Source.Microphone)?.track?.mediaStreamTrack.getSettings();
        if (!stopped) {
          setSnapshot({ rows, settings, at: new Date().toISOString() });
          setUnavailable(false);
        }
      } catch {
        if (!stopped) setUnavailable(true);
      } finally {
        if (!stopped) timer = setTimeout(sample, 2000);
      }
    }
    void sample();
    return () => { stopped = true; clearTimeout(timer); };
  }, [room, connection]);

  function download() {
    const { settings, ...measurements } = snapshot;
    // Exclude persistent device identifiers and credentials from the export.
    const report = {
      ...measurements, connectionMs, connection,
      settings: settings && {
        sampleRate: settings.sampleRate, channelCount: settings.channelCount,
        echoCancellation: settings.echoCancellation, noiseSuppression: settings.noiseSuppression,
        autoGainControl: settings.autoGainControl,
      },
      note: "RTT 是本机到媒体服务器的往返指标，不是两位用户之间的语音延迟。",
    };
    const url = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2)], { type: "application/json" }));
    const link = document.createElement("a");
    link.href = url; link.download = `audio-test-${Date.now()}.json`; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  const settings = snapshot.settings;
  const setting = (value?: boolean) => value == null ? "未报告" : value ? "开" : "关";
  return <section className="panel">
    <h2>连接与音频统计</h2>
    <p>状态：{connection} · 首次连接耗时：{connectionMs == null ? "等待连接" : `${connectionMs} ms`}</p>
    <p className="muted">连接耗时从提交入会开始，含本地 token 请求。以下每 2 秒采样；RTT 是本机到 LiveKit 媒体服务器的往返时间，不是端到端语音延迟。缺失指标显示 —。</p>
    {unavailable && <p role="status">当前无法读取统计；表格保留上次结果。</p>}
    <div className="table-scroll"><table>
      <thead><tr><th>参与者 / 方向</th><th>编码</th><th>码率 kbps</th><th>RTT ms</th><th>抖动 ms</th><th>累计丢包</th><th>累计平均缓冲 ms</th></tr></thead>
      <tbody>{snapshot.rows.map((row, i) => <tr key={`${row.name}-${i}`}>
        <td>{row.name} / {row.direction}</td><td>{row.codec ?? "—"}</td><td>{format(row.bitrateKbps)}</td>
        <td>{format(row.rttMs)}</td><td>{format(row.jitterMs)}</td><td>{row.lostPackets ?? "—"}</td><td>{format(row.bufferMeanMs)}</td>
      </tr>)}</tbody>
    </table></div>
    {snapshot.rows.length === 0 && <p>开启麦克风或等待另一位参与者发布音频后显示。</p>}
    <p className="muted">实际采集：{settings?.sampleRate ?? "—"} Hz · {settings?.channelCount ?? "—"} 声道 · 回声消除 {setting(settings?.echoCancellation)} · 降噪 {setting(settings?.noiseSuppression)} · 自动增益 {setting(settings?.autoGainControl)}</p>
    <button onClick={download} disabled={!snapshot.at}>下载当前统计 JSON</button>
  </section>;
}
