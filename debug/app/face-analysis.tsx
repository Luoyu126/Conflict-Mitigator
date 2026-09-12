"use client";

import { useEffect, useState, type RefObject } from "react";
import type { FaceResult } from "../lib/face-emotion";
import { appendVadTrail, projectVad, VAD_FRESH_MS, VAD_TRAIL_MS, type VadSample } from "../lib/vad";
import VadPlot from "./vad-plot";

type Observation = FaceResult & { requestMs: number; totalMs: number; at: string; sampledAt: number; vad: ReturnType<typeof projectVad>; trail: VadSample[] };
const reasons = { no_face: "未检测到人脸", multiple_faces: "画面中有多张人脸", low_quality: "画面模糊", model_unavailable: "缺少有效表情分数" };

export default function FaceAnalysis({ videoRef, overlayTarget }: { videoRef: RefObject<HTMLVideoElement | null>; overlayTarget: HTMLDivElement | null }) {
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<Observation | null>(null);
  const [error, setError] = useState("");
  const [now, setNow] = useState(0);
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(timer);
  }, [running]);
  useEffect(() => {
    if (!running) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    let controller: AbortController | undefined;
    const canvas = document.createElement("canvas");
    async function sample() {
      try {
        const video = videoRef.current;
        if (!video || video.readyState < 2 || !video.videoWidth) return;
        const started = performance.now();
        const sampledAt = Date.now();
        const scale = Math.min(1, 640 / Math.max(video.videoWidth, video.videoHeight));
        canvas.width = Math.round(video.videoWidth * scale);
        canvas.height = Math.round(video.videoHeight * scale);
        const context = canvas.getContext("2d");
        if (!context) throw new Error("无法读取摄像头画面。");
        // drawImage uses original pixels; CSS mirror is only a display preference.
        context.drawImage(video, 0, 0, canvas.width, canvas.height);
        const frame = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", .75));
        if (stopped) return;
        if (!frame || frame.size > 524288) throw new Error("摄像头抽样帧无法编码或超过大小限制。");
        controller = new AbortController();
        const response = await fetch("/api/face-emotion", {
          method: "POST", headers: { "Content-Type": "image/jpeg", "X-Face-Analysis-Consent": "yes" },
          body: frame, cache: "no-store", signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]),
        });
        const data = await response.json();
        if (stopped) return;
        if (!response.ok) throw new Error(data.error || "表情分析失败。");
        const receivedAt = Date.now();
        const vad = receivedAt - sampledAt <= VAD_FRESH_MS ? projectVad(data) : null;
        setNow(receivedAt);
        setResult((previous) => ({ ...data, sampledAt, vad,
          trail: appendVadTrail(previous?.trail ?? [], vad, sampledAt),
          totalMs: Math.round(performance.now() - started), at: new Date(sampledAt).toLocaleTimeString(),
        }));
      } catch (error) {
        if (!stopped) {
          setError(error instanceof Error ? error.message : "表情分析失败。");
          setResult(null); setRunning(false); stopped = true;
        }
      } finally {
        if (!stopped) timer = setTimeout(sample, 1200);
      }
    }
    void sample();
    return () => { stopped = true; clearTimeout(timer); controller?.abort(); canvas.width = 0; canvas.height = 0; };
  }, [running, videoRef]);

  const stale = result != null && now - result.sampledAt > VAD_FRESH_MS;
  const point = running && !stale ? result?.vad ?? null : null;
  const status = !running ? "分析未开启" : stale ? "采样已过期，等待新结果"
    : !result ? "等待首次采样" : result.reason ? reasons[result.reason] : "无法获得有效坐标";
  return <div className="face-analysis">
    <p className="muted">Face++ 表情实验：开始后定时发送你自己的摄像头 JPEG 至 Face++，请求完成后至少间隔 1.2 秒。本应用不保存图片；停止后不再发送新帧，已发送的请求无法撤回。</p>
    <button type="button" aria-pressed={running} onClick={() => { setResult(null); setError(""); setRunning((value) => !value); }}>
      {running ? "停止表情分析" : "同意并开始表情分析"}
    </button>
    {error && <p role="alert">{error} 分析已停止，可手动重试。</p>}
    {running && !result && <p role="status">正在等待分析结果…</p>}
    <VadPlot overlayTarget={overlayTarget} point={point} trail={point ? result!.trail.filter((p) => now - p.at <= VAD_TRAIL_MS) : []} status={status} />
    {result && <>
      <p>最近采样：{result.at}{stale ? "（已过期，仅供回看）" : ""} · 请求往返 {result.requestMs} ms · 本次采样至结果 {result.totalMs} ms</p>
      {result.status === "ok" ? <div className="emotion-scores">{result.scores.map((s) => <div key={s.name}>
        <span>{s.label} {s.score.toFixed(1)} / 100</span><meter min={0} max={100} value={s.score} aria-label={s.label} />
      </div>)}</div> : <p>无法判断：{result.reason ? reasons[result.reason] : "结果不可用"}</p>}
    </>}
    <p className="muted">分数是模型对表情类别的估计，不代表真实心理状态，也不参与冲突评分。上述耗时不是摄像头传输延迟。</p>
  </div>;
}
