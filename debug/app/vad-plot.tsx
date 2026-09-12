"use client";

import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { VOICE_VAD_ANCHORS as VAD_ANCHORS, VOICE_VAD_VERSION as VAD_VERSION, type Vad, type VadSample } from "../lib/vad";

type Point = Vad & { intensity: number };
const defaultView = { yaw: -.55, pitch: .5 };
export default function VadPlot({ point, trail, status, overlayTarget = null, inline = false,
  anchors = VAD_ANCHORS, names = {}, version = VAD_VERSION, source = "Hume", freshness = "收到完整语音片段超过 6 秒",
}: { point: Point | null; trail: VadSample[]; status: string; overlayTarget?: HTMLDivElement | null;
  inline?: boolean; anchors?: Record<string, Vad>; names?: Record<string, string>; version?: string; source?: string; freshness?: string }) {
  const [view, setView] = useState(defaultView);
  const [animated, setAnimated] = useState<Vad | null>(point);
  const displayed = useRef<Vad | null>(point);
  const drag = useRef<{ x: number; y: number } | null>(null);
  const markerId = useId().replaceAll(":", "");
  useEffect(() => {
    let frame = 0;
    const start = performance.now();
    const from = displayed.current ?? point;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    function tick(now: number) {
      const fraction = reduced ? 1 : Math.min(1, (now - start) / 400);
      const t = 1 - (1 - fraction) ** 3;
      const value = point && from ? {
        v: from.v + (point.v - from.v) * t,
        a: from.a + (point.a - from.a) * t,
        d: from.d + (point.d - from.d) * t,
      } : null;
      displayed.current = value; setAnimated(value);
      if (fraction < 1) frame = requestAnimationFrame(tick);
    }
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [point]);
  const project = ({ v, a, d }: Vad) => {
    const x = v * Math.cos(view.yaw) - d * Math.sin(view.yaw);
    const z = v * Math.sin(view.yaw) + d * Math.cos(view.yaw);
    return { x: 210 + x * 100, y: 228 - (a * Math.cos(view.pitch) - z * Math.sin(view.pitch)) * 100 };
  };
  const origin = project({ v: 0, a: 0, d: 0 });
  const current = point && animated ? project(animated) : null;
  const rotate = (yaw: number, pitch: number) => setView((old) => ({ yaw: old.yaw + yaw, pitch: Math.max(.1, Math.min(1.2, old.pitch + pitch)) }));
  const line = (a: Vad, b: Vad, key: string, color: string, dash?: string) => {
    const p = project(a), q = project(b);
    return <line key={key} x1={p.x} y1={p.y} x2={q.x} y2={q.y} stroke={color} strokeDasharray={dash} />;
  };
  const axes = [
    { end: { v: 1.25, a: 0, d: 0 }, start: { v: -1.2, a: 0, d: 0 }, label: "X · Valence", color: "#7dd3fc" },
    { end: { v: 0, a: 1.4, d: 0 }, start: { v: 0, a: 0, d: 0 }, label: "Y · Arousal", color: "#fbbf24" },
    { end: { v: 0, a: 0, d: 1.25 }, start: { v: 0, a: 0, d: -1.2 }, label: "Z · Dominance", color: "#c4b5fd" },
  ];
  const graph = <div className={inline ? "vad-inline" : "vad-overlay"} title="VAD 实验向量 · 拖动旋转">
    <span className="vad-overlay-caption">VAD{point ? "" : " · 未知"}</span>
    <div className="vad-interaction" tabIndex={0} role="group" aria-label="拖动旋转三维图，也可用方向键旋转" onKeyDown={(event) => {
      const steps: Record<string, [number, number]> = { ArrowLeft: [-.15, 0], ArrowRight: [.15, 0], ArrowUp: [0, .1], ArrowDown: [0, -.1] };
      if (steps[event.key]) { event.preventDefault(); rotate(...steps[event.key]); }
    }} onPointerDown={(event) => { drag.current = { x: event.clientX, y: event.clientY }; event.currentTarget.setPointerCapture(event.pointerId); }}
      onPointerMove={(event) => { if (drag.current) { rotate((event.clientX - drag.current.x) * .008, (event.clientY - drag.current.y) * .008); drag.current = { x: event.clientX, y: event.clientY }; } }}
      onPointerUp={() => { drag.current = null; }} onPointerCancel={() => { drag.current = null; }} onLostPointerCapture={() => { drag.current = null; }}>
      <svg viewBox="0 0 420 350" role="img" aria-label={point ? `情绪向量：正负 ${point.v.toFixed(2)}，激活 ${point.a.toFixed(2)}，掌控 ${point.d.toFixed(2)}` : status}>
        <defs><marker id={markerId} markerWidth="5" markerHeight="5" refX="4" refY="2" orient="auto" markerUnits="strokeWidth"><path d="M0,0 L0,4 L5,2 z" fill="#6ee7b7" /></marker></defs>
        {[-1, -.5, 0, .5, 1].flatMap((n) => [
          line({ v: n, a: 0, d: -1 }, { v: n, a: 0, d: 1 }, `v${n}`, "#2d3d50"),
          line({ v: -1, a: 0, d: n }, { v: 1, a: 0, d: n }, `d${n}`, "#2d3d50"),
        ])}
        {axes.map((axis) => { const end = project(axis.end); return <g key={axis.label}>
          {line(axis.start, axis.end, axis.label, axis.color)}
          <text x={end.x} y={end.y - 10} textAnchor="middle" fill={axis.color}>{axis.label}</text>
        </g>; })}
        {Object.entries(anchors).map(([name, anchor]) => { const p = project(anchor); return <circle key={name} cx={p.x} cy={p.y} r="3" fill="#71869b"><title>{`${names[name] ?? name}参考点`}</title></circle>; })}
        {point && trail.length > 1 && <polyline data-vad-trail="true" points={trail.map((p) => { const q = project(p); return `${q.x},${q.y}`; }).join(" ")} fill="none" stroke="#6ee7b7" strokeWidth="1" opacity=".35" />}
        {current && <>
          {line({ v: animated!.v, a: 0, d: animated!.d }, animated!, "height", "#6ee7b7", "4 4")}
          <line data-vad-vector="true" x1={origin.x} y1={origin.y} x2={current.x} y2={current.y} stroke="#6ee7b7" strokeWidth="1.5" markerEnd={`url(#${markerId})`} />
          <circle cx={current.x} cy={current.y} r="2.5" fill="#6ee7b7" />
        </>}
        <circle cx={origin.x} cy={origin.y} r="2" fill="#fff" />

      </svg>
    </div>
    </div>;
  return <section className="vad-panel" aria-label="三维情绪向量">
    <div className="vad-heading"><strong>VAD 三维情绪空间</strong><span className="vad-badge">实验映射</span></div>
    {inline ? graph : overlayTarget && createPortal(graph, overlayTarget)}
    {!point && <p className="muted" role="status">{status}</p>}
    <div className="vad-tools"><span>拖动 / 方向键旋转 · 近 30 秒轨迹</span><button type="button" onClick={() => setView(defaultView)}>重置视角</button></div>
    <div className="vad-coordinates">{[["X · Valence [-1,1]", point?.v], ["Y · Arousal [0,1]", point?.a], ["Z · Dominance [-1,1]", point?.d]].map(([label, value]) => <div key={label as string}><span>{label}</span><strong>{typeof value === "number" ? value.toFixed(3) : "—"}</strong></div>)}</div>
    <div className="vad-intensity"><span>综合情绪强度 · 0～1</span><output data-vad-intensity="true">{point ? point.intensity.toFixed(3) : "—"}</output><meter min={0} max={1} value={point?.intensity ?? 0} aria-label="实验综合情绪强度" hidden={!point} /></div>
    <p className="muted">坐标和分数对应最新有效采样；向量用 400 ms 动画过渡。正向激动也可获得高强度，这不是冲突分数。</p>
    <details><summary>查看实验映射参数</summary>
      <p className="muted">{version} · 将 {Object.keys(anchors).length} 类分数归一化后，对下表参考点加权。参考点为可校准的设计参数，不是 {source} 实测 VAD；掌控感尤其需要验证。归一化后的权重仅用于可视化，不是情绪概率。</p>
      <div className="table-scroll"><table><thead><tr><th>情绪</th><th>X</th><th>Y</th><th>Z</th></tr></thead><tbody>{Object.entries(anchors).map(([name, p]) => <tr key={name}><td>{names[name] ?? name}</td><td>{p.v}</td><td>{p.a}</td><td>{p.d}</td></tr>)}</tbody></table></div>
      <p className="muted">intensity = √(0.15X² + 0.70Y² + 0.15Z²)。无效或{freshness}显示未知；当前仅作实验展示，不写入正式 emotionIntensity。</p>
    </details>
  </section>;
}
