"use client";

import { useId, useRef, useState } from "react";
import type { AffectResult } from "../../contracts/affect";
import styles from "./affect-vad-plot.module.css";

type VadPoint = NonNullable<AffectResult["vad"]>;
export type AffectVadPlotProps = {
  /** The caller supplies only the current user's consent-valid modality result.
   * Pass null immediately when unavailable, stale, or consent is withdrawn. */
  point: AffectResult["vad"];
  label: string;
  trail?: { at: number; point: VadPoint }[];
};
type Coordinates = Pick<VadPoint, "valence" | "arousal" | "dominance">;
const INITIAL_VIEW = { yaw: -.55, pitch: .5 };
const ORIGIN: Coordinates = { valence: 0, arousal: 0, dominance: 0 };
const TRAIL_WINDOW_MS = 30_000;
const TRAIL_GAP_MS = 6_000;
const axes: { name: keyof Coordinates; label: string; min: number; max: number; color: string }[] = [
  { name: "valence", label: "Valence", min: -1, max: 1, color: "#526f60" },
  { name: "arousal", label: "Arousal", min: 0, max: 1, color: "#806b43" },
  { name: "dominance", label: "Dominance", min: -1, max: 1, color: "#76667c" },
];
function valid(point: VadPoint | null): point is VadPoint {
  return point !== null && axes.every(({ name, min, max }) => Number.isFinite(point[name]) && point[name] >= min && point[name] <= max);
}

/** One independent rotatable display per modality; no fusion or score averaging. */
export default function AffectVadPlot({ point, label, trail = [] }: AffectVadPlotProps) {
  const [view, setView] = useState(INITIAL_VIEW);
  const drag = useRef<{ pointerId: number; x: number; y: number } | null>(null);
  const id = useId().replaceAll(":", "");
  const titleId = `${id}-title`;
  const captionId = `${id}-caption`;
  const markerId = `${id}-arrow`;
  const current = valid(point) ? point : null;
  const project = ({ valence, arousal, dominance }: Coordinates) => {
    const x = valence * Math.cos(view.yaw) - dominance * Math.sin(view.yaw);
    const z = valence * Math.sin(view.yaw) + dominance * Math.cos(view.yaw);
    return { x: 210 + x * 88, y: 220 - (arousal * Math.cos(view.pitch) - z * Math.sin(view.pitch)) * 88 };
  };
  const rotate = (yaw: number, pitch: number) => setView((old) => ({
    yaw: (old.yaw + yaw) % (Math.PI * 2), pitch: Math.max(.1, Math.min(1.2, old.pitch + pitch)),
  }));
  const origin = project(ORIGIN);
  const projected = current ? project(current) : null;
  // Do not connect across unavailable gaps, mapping changes, or modality versions.
  const samples = current ? trail.filter((sample) => Number.isFinite(sample.at) && valid(sample.point)
    && sample.point.mappingVersion === current.mappingVersion).sort((a, b) => a.at - b.at).slice(-24) : [];
  const lastAt = samples.at(-1)?.at ?? 0;
  const paths: string[][] = [];
  let previousAt: number | null = null;
  for (const sample of samples) {
    if (lastAt - sample.at > TRAIL_WINDOW_MS) continue;
    if (previousAt === null || sample.at - previousAt > TRAIL_GAP_MS) paths.push([]);
    const position = project(sample.point);
    paths[paths.length - 1].push(`${position.x},${position.y}`);
    previousAt = sample.at;
  }
  const line = (from: Coordinates, to: Coordinates, key: string, className?: string) => {
    const start = project(from), end = project(to);
    return <line key={key} x1={start.x} y1={start.y} x2={end.x} y2={end.y} className={className} />;
  };
  const coordinatesLabel = current
    ? axes.map(({ name, label: axisLabel }) => `${axisLabel} ${current[name].toFixed(2)}`).join(", ")
    : "Unknown — no current valid observation";

  return <section className={styles.panel} aria-labelledby={titleId} aria-describedby={captionId}>
    <div className={styles.heading}>
      <h4 id={titleId}>{label} · VAD</h4>
      <span className={styles.badge}>Experimental</span>
    </div>
    <div className={styles.interaction} role="group" tabIndex={0}
      aria-label={`${label} three-dimensional plot. Drag or use arrow keys to rotate; Home resets the view.`}
      onKeyDown={(event) => {
        const steps: Record<string, [number, number]> = { ArrowLeft: [-.15, 0], ArrowRight: [.15, 0], ArrowUp: [0, .1], ArrowDown: [0, -.1] };
        if (event.key === "Home") { event.preventDefault(); setView(INITIAL_VIEW); }
        else if (steps[event.key]) { event.preventDefault(); rotate(...steps[event.key]); }
      }}
      onPointerDown={(event) => {
        if (!event.isPrimary || event.button !== 0) return;
        drag.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY };
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={(event) => {
        if (drag.current?.pointerId !== event.pointerId) return;
        rotate((event.clientX - drag.current.x) * .008, (event.clientY - drag.current.y) * .008);
        drag.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY };
      }}
      onPointerUp={() => { drag.current = null; }} onPointerCancel={() => { drag.current = null; }}
      onLostPointerCapture={() => { drag.current = null; }}>
      <svg viewBox="0 0 420 340" role="img" aria-label={`${label}: ${coordinatesLabel}`}>
        <defs><marker id={markerId} markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto">
          <path d="M0,0 L0,6 L6,3 z" className={styles.marker} />
        </marker></defs>
        {[-1, -.5, 0, .5, 1].flatMap((n) => [
          line({ ...ORIGIN, valence: n, dominance: -1 }, { ...ORIGIN, valence: n, dominance: 1 }, `v${n}`, styles.grid),
          line({ ...ORIGIN, valence: -1, dominance: n }, { ...ORIGIN, valence: 1, dominance: n }, `d${n}`, styles.grid),
        ])}
        {axes.map((axis) => {
          const start = project({ ...ORIGIN, [axis.name]: axis.min * 1.18 });
          const end = project({ ...ORIGIN, [axis.name]: axis.max * 1.3 });
          return <g key={axis.name}>
            <line x1={start.x} y1={start.y} x2={end.x} y2={end.y} stroke={axis.color} />
            <text x={end.x} y={end.y - 10} textAnchor="middle" fill={axis.color}>{axis.label}</text>
          </g>;
        })}
        {paths.filter((path) => path.length > 1).map((path, index) => <polyline key={index}
          data-vad-trail="true" points={path.join(" ")} className={styles.trail} />)}
        {current && projected && <>
          {line({ ...current, arousal: 0 }, current, "height", styles.height)}
          <line data-vad-vector="true" x1={origin.x} y1={origin.y} x2={projected.x} y2={projected.y}
            className={styles.vector} markerEnd={`url(#${markerId})`} />
          <circle cx={projected.x} cy={projected.y} r="4" className={styles.marker} />
        </>}
        <circle cx={origin.x} cy={origin.y} r="2.5" fill="#656e61" />
        {!current && <text x="210" y="40" textAnchor="middle" className={styles.unknown}>Unknown</text>}
      </svg>
    </div>
    <div className={styles.tools}><span>Drag or use arrow keys to rotate</span>
      <button type="button" onClick={() => setView(INITIAL_VIEW)} aria-label={`Reset ${label} plot view`}>Reset view</button>
    </div>
    <dl className={styles.coordinates}>{axes.map((axis) => <div key={axis.name}>
      <dt>{axis.label} <span>[{axis.min}, {axis.max}]</span></dt>
      <dd>{current ? current[axis.name].toFixed(2) : "—"}</dd>
    </div>)}</dl>
    {!current && <p className={styles.status} role="status">Unknown · waiting for a current observation.</p>}
    <p className={styles.caption} id={captionId}>Experimental display mapping, not a calibrated measure of emotion or conflict.
      {current && <span className={styles.version}>{current.mappingVersion}</span>}
    </p>
  </section>;
}
