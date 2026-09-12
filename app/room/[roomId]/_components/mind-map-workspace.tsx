"use client";

import { useRouter } from "next/navigation";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type PointerEvent as ReactPointerEvent,
  type WheelEvent as ReactWheelEvent,
} from "react";
import type {
  MindMapData,
  MindMapNode,
  NodeStatus,
  TranscriptData,
  TranscriptSegment,
} from "@/contracts/mind-map";
import styles from "./mind-map-workspace.module.css";
import { buildPositionedNodes, getMapViewport, MAP_CENTER as CENTER } from "@/lib/ui/mind-map-layout";

type MindMapWorkspaceProps = {
  roomId: string;
  live?: { title: string; participants: ReactNode; controls: ReactNode; notice: ReactNode; transcriptTools?: ReactNode; onSelectNode?: (nodeId: string) => void };
  mindMap: MindMapData;
  transcript: TranscriptData;
  initialReplayAt?: number;
  autoPlayReplay?: boolean;
  resumedNodeId?: string;
};

type ViewMode = "snapshot" | "replay";

const MEDIATION_CONTENTION_THRESHOLD = 0.7;

function completedMediationsStorageKey(roomId: string) {
  return `conflict-mitigator:completed-mediations:${roomId}`;
}

const statusLabels: Record<NodeStatus, string> = {
  normal: "Active topic",
  heated: "High contention",
  private_mediation: "Private mediation",
  ready_to_resume: "Ready to resume",
};

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function formatTime(milliseconds: number) {
  const totalSeconds = Math.floor(milliseconds / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

function splitLabel(label: string, maxCharacters = 25) {
  const words = label.split(" ");
  const lines: string[] = [];
  let line = "";

  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (candidate.length <= maxCharacters) {
      line = candidate;
    } else {
      if (line) lines.push(line);
      line = word;
    }
  }

  if (line) lines.push(line);
  if (lines.length <= 2) return lines;
  return [lines[0], `${lines.slice(1).join(" ").slice(0, maxCharacters - 1)}…`];
}

function getInitials(name: string) {
  return name
    .split(" ")
    .map((part) => part[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
}

function buildReplayNodes(
  snapshotNodes: MindMapNode[],
  events: TranscriptData["mindMapEvents"],
  currentTime: number,
) {
  const snapshotById = new Map(snapshotNodes.map((node) => [node.id, node]));
  const replayNodes = new Map<string, MindMapNode>();

  for (const event of events) {
    if (event.atMs > currentTime) break;
    const existing = replayNodes.get(event.nodeId);
    const reference = snapshotById.get(event.nodeId);
    if (!existing && !reference) continue;

    replayNodes.set(event.nodeId, {
      ...(reference as MindMapNode),
      ...existing,
      ...event.patch,
      id: event.nodeId,
      roomId: reference?.roomId ?? "",
    });
  }

  return Array.from(replayNodes.values());
}

export default function MindMapWorkspace({
  roomId,
  live,
  mindMap,
  transcript,
  initialReplayAt,
  autoPlayReplay = false,
  resumedNodeId,
}: MindMapWorkspaceProps) {
  const router = useRouter();
  const hasInitialReplay = typeof initialReplayAt === "number";
  const [viewMode, setViewMode] = useState<ViewMode>(
    hasInitialReplay ? "replay" : "snapshot",
  );
  const [currentTime, setCurrentTime] = useState(
    hasInitialReplay
      ? clamp(initialReplayAt, 0, transcript.mockMeta.durationMs)
      : transcript.mockMeta.durationMs,
  );
  const [isPlaying, setIsPlaying] = useState(
    hasInitialReplay && autoPlayReplay,
  );
  const [selectedNodeId, setSelectedNodeId] = useState(
    resumedNodeId ?? mindMap.nodes[0]?.id ?? "",
  );
  const [highlightedSegmentIds, setHighlightedSegmentIds] = useState<string[]>([]);
  const [zoom, setZoom] = useState(0.92);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [mediationCandidate, setMediationCandidate] =
    useState<MindMapNode | null>(null);
  const [showResumeNotice, setShowResumeNotice] = useState(Boolean(resumedNodeId));
  const [completedMediationNodeIds, setCompletedMediationNodeIds] = useState(
    () => new Set(resumedNodeId ? [resumedNodeId] : []),
  );
  const segmentRefs = useRef(new Map<string, HTMLDivElement>());
  const handledReplayTriggersRef = useRef(new Set<string>());
  const replayPausedForMediationRef = useRef(false);
  const activeMediationTriggerAtRef = useRef<number | null>(null);
  const dragRef = useRef<{
    pointerId: number;
    x: number;
    y: number;
    startPanX: number;
    startPanY: number;
  } | null>(null);

  const activeNodes = useMemo(
    () => {
      const nodes = viewMode === "snapshot"
        ? mindMap.nodes
        : buildReplayNodes(
            mindMap.nodes,
            transcript.mindMapEvents,
            currentTime,
          );

      if (live) return nodes;
      return nodes.map((node) =>
        completedMediationNodeIds.has(node.id)
          ? {
              ...node,
              status: "ready_to_resume" as const,
              contentionScore: Math.min(node.contentionScore, 0.42),
              readinessScore: Math.max(node.readinessScore ?? 0, 0.88),
            }
          : node,
      );
    },
    [
      completedMediationNodeIds,
      live,
      currentTime,
      mindMap.nodes,
      transcript.mindMapEvents,
      viewMode,
    ],
  );

  const positionedNodes = useMemo(
    () => buildPositionedNodes(activeNodes),
    [activeNodes],
  );
  const viewport = useMemo(() => getMapViewport(positionedNodes), [positionedNodes]);
  const positionById = useMemo(
    () => new Map(positionedNodes.map((item) => [item.node.id, item])),
    [positionedNodes],
  );
  const selectedNode =
    activeNodes.find((node) => node.id === selectedNodeId) ?? activeNodes[0];
  const resumedNode = resumedNodeId
    ? mindMap.nodes.find((node) => node.id === resumedNodeId)
    : undefined;

  const visibleTranscript = useMemo(() => {
    const cutoff = viewMode === "snapshot" ? Number.POSITIVE_INFINITY : currentTime;
    return transcript.transcriptSegments.filter(
      (segment) => segment.startedAtMs <= cutoff,
    );
  }, [currentTime, transcript.transcriptSegments, viewMode]);

  const replayMediationTriggers = useMemo(
    () =>
      transcript.mindMapEvents.filter(
        (event) =>
          event.patch.status === "heated" &&
          (event.patch.contentionScore ?? 0) >= MEDIATION_CONTENTION_THRESHOLD &&
          transcript.mindMapEvents.some(
            (laterEvent) =>
              laterEvent.nodeId === event.nodeId &&
              laterEvent.atMs > event.atMs &&
              laterEvent.patch.status === "private_mediation",
          ),
      ),
    [transcript.mindMapEvents],
  );

  const replayMediationWindows = useMemo(
    () =>
      replayMediationTriggers.map((trigger) => {
        const resume = transcript.mindMapEvents.find(
          (event) =>
            event.nodeId === trigger.nodeId &&
            event.atMs > trigger.atMs &&
            event.patch.status === "ready_to_resume",
        );
        return {
          id: `${trigger.nodeId}-${trigger.atMs}`,
          startAt: trigger.atMs,
          endAt: resume?.atMs ?? trigger.atMs,
        };
      }),
    [replayMediationTriggers, transcript.mindMapEvents],
  );

  useEffect(() => {
    if (live) return;
    const timer = window.setTimeout(() => {
      try {
        const stored = window.sessionStorage.getItem(
          completedMediationsStorageKey(roomId),
        );
        const storedNodeIds = stored ? (JSON.parse(stored) as string[]) : [];
        const merged = new Set(storedNodeIds);
        if (resumedNodeId) merged.add(resumedNodeId);
        setCompletedMediationNodeIds(merged);
        if (resumedNodeId) {
          window.sessionStorage.setItem(
            completedMediationsStorageKey(roomId),
            JSON.stringify(Array.from(merged)),
          );
        }
      } catch {
        // The URL-provided node still supplies the demo state if storage is unavailable.
      }
    }, 0);
    return () => window.clearTimeout(timer);
  }, [resumedNodeId, roomId, live]);

  useEffect(() => {
    if (!isPlaying || viewMode !== "replay") return;

    const timer = window.setInterval(() => {
      setCurrentTime((time) => {
        if (replayPausedForMediationRef.current) return time;
        const nextTime = time + 15000;
        const mediationTrigger = replayMediationTriggers.find(
          (event) =>
            event.atMs > time &&
            event.atMs <= nextTime &&
            !handledReplayTriggersRef.current.has(
              `${event.nodeId}-${event.atMs}`,
            ),
        );

        if (mediationTrigger) {
          replayPausedForMediationRef.current = true;
          activeMediationTriggerAtRef.current = mediationTrigger.atMs;
          handledReplayTriggersRef.current.add(
            `${mediationTrigger.nodeId}-${mediationTrigger.atMs}`,
          );
          const candidate = buildReplayNodes(
            mindMap.nodes,
            transcript.mindMapEvents,
            mediationTrigger.atMs,
          ).find((node) => node.id === mediationTrigger.nodeId);

          if (candidate) {
            setSelectedNodeId(candidate.id);
            setHighlightedSegmentIds(candidate.sourceSegmentIds ?? []);
            setMediationCandidate(candidate);
          }
          setIsPlaying(false);
          return mediationTrigger.atMs;
        }

        if (nextTime >= transcript.mockMeta.durationMs) {
          setIsPlaying(false);
          return transcript.mockMeta.durationMs;
        }
        return nextTime;
      });
    }, 120);

    return () => window.clearInterval(timer);
  }, [
    isPlaying,
    mindMap.nodes,
    replayMediationTriggers,
    transcript.mindMapEvents,
    transcript.mockMeta.durationMs,
    viewMode,
  ]);

  const jumpToTranscript = (node: MindMapNode) => {
    setSelectedNodeId(node.id);
    const sourceIds = node.sourceSegmentIds ?? [];
    setHighlightedSegmentIds(sourceIds);
    const firstSource = sourceIds.find((id) => segmentRefs.current.has(id));
    if (!firstSource) return;

    window.requestAnimationFrame(() => {
      segmentRefs.current.get(firstSource)?.scrollIntoView({
        behavior: "smooth",
        block: "center",
      });
    });
  };

  const selectNode = (node: MindMapNode) => {
    jumpToTranscript(node);
    if (live) { live.onSelectNode?.(node.id); return; }

    const isChildTopic = Boolean(node.parentNodeId);
    const crossedThreshold =
      node.status === "heated" ||
      (node.status === "normal" &&
        node.contentionScore >= MEDIATION_CONTENTION_THRESHOLD);

    if (isChildTopic && crossedThreshold) {
      if (viewMode === "replay") {
        replayPausedForMediationRef.current = true;
        activeMediationTriggerAtRef.current = currentTime;
      }
      setMediationCandidate(node);
    }
  };

  const enterMediation = () => {
    if (!mediationCandidate) return;
    const query = new URLSearchParams();

    if (viewMode === "replay") {
      const triggerTime = activeMediationTriggerAtRef.current ?? currentTime;
      const resumeEvent = transcript.mindMapEvents.find(
        (event) =>
          event.nodeId === mediationCandidate.id &&
          event.atMs > triggerTime &&
          event.patch.status === "ready_to_resume",
      );
      query.set("fromReplay", "1");
      query.set("triggerAt", `${triggerTime}`);
      query.set("resumeAt", `${resumeEvent?.atMs ?? triggerTime}`);
    }

    const search = query.size ? `?${query.toString()}` : "";
    router.push(
      `/room/${encodeURIComponent(roomId)}/mediation/${encodeURIComponent(mediationCandidate.id)}${search}`,
    );
  };

  const changeViewMode = (mode: ViewMode) => {
    replayPausedForMediationRef.current = false;
    activeMediationTriggerAtRef.current = null;
    setViewMode(mode);
    if (mode === "snapshot") {
      setIsPlaying(false);
      setCurrentTime(transcript.mockMeta.durationMs);
    } else {
      if (viewMode === "snapshot" || currentTime >= transcript.mockMeta.durationMs) {
        setCompletedMediationNodeIds(new Set());
        window.sessionStorage.removeItem(completedMediationsStorageKey(roomId));
        handledReplayTriggersRef.current.clear();
        setCurrentTime(0);
        setSelectedNodeId(mindMap.nodes[0]?.id ?? "");
        setHighlightedSegmentIds([]);
      }
      setIsPlaying(true);
    }
  };

  const togglePlayback = () => {
    replayPausedForMediationRef.current = false;
    setViewMode("replay");
    if (currentTime >= transcript.mockMeta.durationMs) {
      setCompletedMediationNodeIds(new Set());
      window.sessionStorage.removeItem(completedMediationsStorageKey(roomId));
      handledReplayTriggersRef.current.clear();
      setCurrentTime(0);
      setHighlightedSegmentIds([]);
    }
    setIsPlaying((playing) => !playing);
  };

  const resetView = () => {
    setZoom(0.92);
    setPan({ x: 0, y: 0 });
  };

  const onPointerDown = (event: ReactPointerEvent<SVGSVGElement>) => {
    if (event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = {
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      startPanX: pan.x,
      startPanY: pan.y,
    };
  };

  const onPointerMove = (event: ReactPointerEvent<SVGSVGElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const matrix = event.currentTarget.getScreenCTM();
    if (!matrix) return;
    setPan({
      x: drag.startPanX + (event.clientX - drag.x) / matrix.a,
      y: drag.startPanY + (event.clientY - drag.y) / matrix.d,
    });
  };

  const onPointerUp = (event: ReactPointerEvent<SVGSVGElement>) => {
    if (dragRef.current?.pointerId !== event.pointerId) return;
    dragRef.current = null;
    event.currentTarget.releasePointerCapture(event.pointerId);
  };

  const onWheel = (event: ReactWheelEvent<SVGSVGElement>) => {
    event.preventDefault();
    setZoom((value) => clamp(value - event.deltaY * 0.001, 0.3, 5));
  };

  const renderTranscriptItem = (segment: TranscriptSegment) => {
    const highlighted = highlightedSegmentIds.includes(segment.id);
    return (
      <div
        key={segment.id}
        ref={(element) => {
          if (element) segmentRefs.current.set(segment.id, element);
          else segmentRefs.current.delete(segment.id);
        }}
        className={`${styles.transcriptItem} ${highlighted ? styles.transcriptItemHighlighted : ""}`}
        data-segment-id={segment.id}
      >
        <div className={styles.speakerAvatar}>
          {getInitials(segment.speaker)}
        </div>
        <div className={styles.transcriptCopy}>
          <div className={styles.transcriptMeta}>
            <strong>{segment.speaker}</strong>
            <time>{segment.timestampUnavailable ? "—" : formatTime(segment.startedAtMs)}</time>
          </div>
          <p>{segment.content}</p>
        </div>
      </div>
    );
  };

  return (
    <div className={styles.meetingShell}>
      {!live && <div className="cm-demo-label">Design preview · sample conversation and simulated mediation</div>}
      <header className={styles.windowBar}>
        <div className={styles.windowBrand}>
          <span className={styles.windowDots} aria-hidden="true">
            <i />
            <i />
            <i />
          </span>
          <strong>conflict mitigator</strong>
        </div>
        <div className={styles.meetingTitle}>
          {live?.title ?? "Core Product Working Group"}
          <span>⌄</span>
        </div>
        <div className={styles.viewControl}>▦ View · Room {roomId.slice(0, 8)}</div>
      </header>

      <nav className={styles.meetingTabs} aria-label="Meeting views">
        <button disabled={Boolean(live)}>▣ <span>Meeting</span></button>
        <button disabled={Boolean(live)}>▤ <span>Chat</span></button>
        <button className={styles.meetingTabActive}>⌘ <span>Common Ground</span></button>
        <button disabled={Boolean(live)}>▧ <span>Notes</span></button>
        <button disabled={Boolean(live)}>⌁ <span>Apps</span></button>
      </nav>

      <main className={styles.meetingBody}>
        <aside className={styles.transcriptPanel} aria-label="Live meeting transcript">
          <div className={styles.panelHeader}>
            <div>
              <div className={styles.panelTitleRow}>
                <h2>Live Transcript</h2>
                <span className={styles.liveIndicator}><i /> Live</span>
              </div>
              <p>Raw meeting transcript · {visibleTranscript.length} entries</p>
              {live?.transcriptTools}
            </div>
          </div>
          <div className={styles.transcriptScroll}>
            {visibleTranscript.length ? (
              visibleTranscript.map(renderTranscriptItem)
            ) : (
              <div className={styles.transcriptWaiting}>
                <span>●</span>
                Waiting for the first speaker…
              </div>
            )}
          </div>
        </aside>

        <section className={`${styles.mapPanel} ${live ? styles.liveMapPanel : ""}`} aria-label="Common ground map">
          <header className={styles.mapHeader}>
            <div>
              <h1>Common Ground Map</h1>
              <p>A real-time view of topics, perspectives, and friction points.</p>
            </div>
            <div className={styles.mapActions}>
              {!live && <div className={styles.modeTabs} aria-label="Map mode">
                <button
                  className={viewMode === "snapshot" ? styles.modeActive : ""}
                  onClick={() => changeViewMode("snapshot")}
                  aria-pressed={viewMode === "snapshot"}
                >
                  Overview
                </button>
                <button
                  className={viewMode === "replay" ? styles.modeActive : ""}
                  onClick={() => changeViewMode("replay")}
                  aria-pressed={viewMode === "replay"}
                >
                  Replay
                </button>
              </div>
              }
              <button className={styles.fitButton} onClick={resetView}>⌗ Fit to screen</button>
            </div>
          </header>

          {live?.notice}
          {showResumeNotice && resumedNode && (
            <div className={styles.resumeNotice} role="status">
              <span aria-hidden="true">✓</span>
              <p>
                <strong>Mediation complete · {resumedNode.topic}</strong>
                {autoPlayReplay
                  ? `Shared summary approved. Replay resumed from ${formatTime(initialReplayAt ?? currentTime)}.`
                  : `Shared summary approved. Replay is paused at ${formatTime(currentTime)}.`}
              </p>
              {autoPlayReplay ? (
                <button onClick={() => setShowResumeNotice(false)} aria-label="Dismiss mediation complete message">
                  Dismiss
                </button>
              ) : (
                <button
                  onClick={() => {
                    replayPausedForMediationRef.current = false;
                    setShowResumeNotice(false);
                    setIsPlaying(true);
                  }}
                >
                  Continue replay <span aria-hidden="true">→</span>
                </button>
              )}
            </div>
          )}

          {selectedNode && (
            <div className={styles.selectedTopic} aria-live="polite">
              <span className={`${styles.statusDot} ${styles[`statusDot_${selectedNode.status}`]}`} />
              <strong>{selectedNode.topic}</strong>
              <span>{statusLabels[selectedNode.status]}</span>
              <span>Contention {Math.round(selectedNode.contentionScore * 100)}%</span>
              <span>
                Readiness {selectedNode.readinessScore === null ? "—" : `${Math.round(selectedNode.readinessScore * 100)}%`}
              </span>
              <span>{selectedNode.discussionLoopCount} loops</span>
            </div>
          )}

          <div className={styles.mapViewport}>
            <svg
              className={styles.mapCanvas}
              viewBox={`${viewport.x} ${viewport.y} ${viewport.width} ${viewport.height}`}
              role="img"
              aria-labelledby="map-title map-description"
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerCancel={onPointerUp}
              onWheel={onWheel}
              onDoubleClick={resetView}
            >
              <title id="map-title">{`${live?.title ?? "Core Product Working Group"} conversation map`}</title>
              <desc id="map-description">
                Select a node to highlight and jump to its source transcript.
              </desc>
              <defs>
                <filter id="node-glow" x="-100%" y="-100%" width="300%" height="300%">
                  <feGaussianBlur stdDeviation="8" result="blur" />
                  <feMerge>
                    <feMergeNode in="blur" />
                    <feMergeNode in="SourceGraphic" />
                  </feMerge>
                </filter>
              </defs>

              <g
                transform={`translate(${pan.x} ${pan.y}) translate(${CENTER.x} ${CENTER.y}) scale(${zoom}) translate(${-CENTER.x} ${-CENTER.y})`}
              >
                {positionedNodes.map(({ node, x, y }) => {
                  if (!node.parentNodeId) return null;
                  const parent = positionById.get(node.parentNodeId);
                  if (!parent) return null;
                  const controlX = (parent.x + x) / 2 + (y - parent.y) * 0.05;
                  const controlY = (parent.y + y) / 2 - (x - parent.x) * 0.05;

                  return (
                    <path
                      key={`${node.parentNodeId}-${node.id}`}
                      className={`${styles.connection} ${styles[`connection_${node.status}`]}`}
                      d={`M ${parent.x} ${parent.y} Q ${controlX} ${controlY} ${x} ${y}`}
                    />
                  );
                })}

                {positionedNodes.map(({ node, x, y, depth }) => {
                  const selected = node.id === selectedNode?.id;
                  const isRoot = depth === 0;
                  const labelLines = splitLabel(node.topic, isRoot ? 21 : 24);
                  const onRight = depth > 0;
                  const labelX = isRoot ? x : x + (onRight ? 18 : -18);
                  const textAnchor = isRoot ? "middle" : onRight ? "start" : "end";

                  return (
                    <g
                      key={node.id}
                      className={`${styles.mapNode} ${styles[`node_${node.status}`]} ${selected ? styles.nodeSelected : ""}`}
                      onPointerDown={(event) => event.stopPropagation()}
                      onClick={(event) => {
                        event.stopPropagation();
                        selectNode(node);
                      }}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" || event.key === " ") {
                          event.preventDefault();
                          selectNode(node);
                        }
                      }}
                      role="button"
                      tabIndex={0}
                      aria-label={`${node.topic}. ${statusLabels[node.status]}. Jump to source transcript.`}
                    >
                      <title>{`${node.topic}: ${node.summary ?? "No summary"}`}</title>
                      {selected && (
                        <circle
                          className={styles.selectionHalo}
                          cx={x}
                          cy={y}
                          r={isRoot ? 49 : depth === 1 ? 29 : 23}
                        />
                      )}
                      {isRoot ? (
                        <>
                          <circle className={styles.rootHubHalo} cx={x} cy={y} r="43" />
                          <circle className={styles.rootNode} cx={x} cy={y} r="31" />
                          <circle className={styles.rootAccent} cx={x + 25} cy={y - 23} r="6" />
                          <text className={styles.rootMonogram} x={x} y={y + 6} textAnchor="middle">✦</text>
                          <rect
                            className={styles.rootLabelCard}
                            x={x - 108}
                            y={y + 48}
                            width="216"
                            height="70"
                            rx="12"
                          />
                          <text
                            className={styles.rootLabel}
                            x={x}
                            y={y + (labelLines.length === 1 ? 74 : 64)}
                            textAnchor="middle"
                          >
                            {labelLines.map((line, index) => (
                              <tspan key={`${node.id}-${index}`} x={x} dy={index === 0 ? 0 : 18}>
                                {line}
                              </tspan>
                            ))}
                          </text>
                          <text className={styles.rootCaption} x={x} y={y + 105} textAnchor="middle">
                            SHARED CONVERSATION
                          </text>
                        </>
                      ) : (
                        <>
                          <circle
                            className={styles.nodeDot}
                            cx={x}
                            cy={y}
                            r={depth === 1 ? 11 : 7}
                            filter={node.status === "heated" ? "url(#node-glow)" : undefined}
                          />
                          <text
                            className={styles.nodeLabel}
                            x={labelX}
                            y={y - 4}
                            textAnchor={textAnchor}
                          >
                            {labelLines.map((line, index) => (
                              <tspan key={`${node.id}-${index}`} x={labelX} dy={index === 0 ? 0 : 19}>
                                {line}
                              </tspan>
                            ))}
                          </text>
                        </>
                      )}
                      {!isRoot && depth === 1 && (
                        <text
                          className={styles.childCount}
                          x={labelX}
                          y={y + labelLines.length * 19 + 2}
                          textAnchor={textAnchor}
                        >
                          {activeNodes.filter((child) => child.parentNodeId === node.id).length} subtopics
                        </text>
                      )}
                    </g>
                  );
                })}
              </g>
            </svg>

            {(live || viewMode === "replay") && activeNodes.length === 0 && (
              <div className={styles.emptyState} aria-live="polite">
                <strong>Listening…</strong>
                <span>{live ? "The map grows from your discussion as the meeting agent processes it." : "Press play to grow the map from the transcript."}</span>
              </div>
            )}

            <div className={styles.legend} aria-label="Node status legend">
              {(Object.entries(statusLabels) as [NodeStatus, string][]).map(([status, label]) => (
                <span key={status}>
                  <i className={styles[`legend_${status}`]} />
                  {label}
                </span>
              ))}
            </div>

            <div className={styles.zoomControls} aria-label="Zoom controls">
              <button onClick={() => setZoom((value) => clamp(value + 0.1, 0.3, 5))} aria-label="Zoom in">＋</button>
              <button onClick={() => setZoom((value) => clamp(value - 0.1, 0.3, 5))} aria-label="Zoom out">−</button>
              <button onClick={resetView} aria-label="Fit to screen">⌗</button>
            </div>

            {!live && <div className={styles.replayBar}>
              <button onClick={togglePlayback} aria-label={isPlaying ? "Pause replay" : "Play replay"}>
                {isPlaying ? "Ⅱ" : "▶"}
              </button>
              <span>{formatTime(currentTime)}</span>
              <div
                className={`${styles.timelineTrack} ${viewMode === "snapshot" ? styles.timelineTrackDisabled : ""}`}
                title={viewMode === "snapshot" ? "Select Replay to scrub the timeline" : undefined}
              >
                <div className={styles.mediationRanges} aria-hidden="true">
                  {replayMediationWindows.map((window) => (
                    <i
                      key={window.id}
                      style={{
                        left: `${(window.startAt / transcript.mockMeta.durationMs) * 100}%`,
                        width: `${((window.endAt - window.startAt) / transcript.mockMeta.durationMs) * 100}%`,
                      }}
                    ><span>Mediation</span></i>
                  ))}
                </div>
                <input
                  type="range"
                  min="0"
                  max={transcript.mockMeta.durationMs}
                  step="1000"
                  value={currentTime}
                  disabled={viewMode === "snapshot"}
                  onChange={(event) => {
                    const requestedTime = Number(event.target.value);
                    const mediationTrigger = replayMediationTriggers.find(
                      (trigger) =>
                        trigger.atMs > currentTime &&
                        trigger.atMs <= requestedTime &&
                        !handledReplayTriggersRef.current.has(
                          `${trigger.nodeId}-${trigger.atMs}`,
                        ),
                    );

                    setIsPlaying(false);
                    replayPausedForMediationRef.current = false;
                    setHighlightedSegmentIds([]);

                    if (!mediationTrigger) {
                      setCurrentTime(requestedTime);
                      if (requestedTime === 0) {
                        setCompletedMediationNodeIds(new Set());
                        window.sessionStorage.removeItem(
                          completedMediationsStorageKey(roomId),
                        );
                        handledReplayTriggersRef.current.clear();
                        setIsPlaying(true);
                      }
                      return;
                    }

                    handledReplayTriggersRef.current.add(
                      `${mediationTrigger.nodeId}-${mediationTrigger.atMs}`,
                    );
                    replayPausedForMediationRef.current = true;
                    activeMediationTriggerAtRef.current = mediationTrigger.atMs;
                    const candidate = buildReplayNodes(
                      mindMap.nodes,
                      transcript.mindMapEvents,
                      mediationTrigger.atMs,
                    ).find((node) => node.id === mediationTrigger.nodeId);
                    setCurrentTime(mediationTrigger.atMs);
                    if (candidate) {
                      setSelectedNodeId(candidate.id);
                      setHighlightedSegmentIds(candidate.sourceSegmentIds ?? []);
                      setMediationCandidate(candidate);
                    }
                  }}
                  aria-label="Replay position"
                />
              </div>
              <span>{formatTime(transcript.mockMeta.durationMs)}</span>
            </div>
          }
          </div>
        </section>

        <aside className={`${styles.videoPanel} ${live ? styles.liveVideoPanel : ""}`} aria-label="Meeting participants">
          {live ? live.participants : <>
          <div className={`${styles.videoTile} ${styles.videoTileWarm}`}>
            <div className={styles.videoGlow} />
            <div className={styles.videoAvatar}>CR</div>
            <div className={styles.videoName}><span>●</span> Chelsea Rathbun</div>
            <div className={styles.videoSignal}>Speaking</div>
          </div>
          <div className={`${styles.videoTile} ${styles.videoTileCool}`}>
            <div className={styles.videoGlow} />
            <div className={styles.videoAvatar}>JM</div>
            <div className={styles.videoName}><span>●</span> Jenna Makowski</div>
            <div className={styles.videoMuted}>⌁ Muted</div>
          </div>
          </>}
        </aside>
      </main>

      <footer className={styles.meetingControls}>
        {live ? live.controls : <>
        <div className={styles.controlGroup}>
          <button><span>♩</span>Mute</button>
          <button><span>▰</span>Stop Video</button>
        </div>
        <div className={styles.controlGroupCenter}>
          <button><span>♟</span>Participants <sup>7</sup></button>
          <button><span>▰</span>Chat</button>
          <button className={styles.shareButton}><span>↥</span>Share Screen</button>
          <button><span>◎</span>Record</button>
          <button><span>☺</span>Reactions</button>
          <button><span>•••</span>More</button>
        </div>
        <button className={styles.leaveButton}>Leave</button>
        </>}
      </footer>

      {mediationCandidate && (
        <div
          className={styles.mediationOverlay}
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) {
              setMediationCandidate(null);
            }
          }}
        >
          <section
            className={styles.mediationPrompt}
            role="dialog"
            aria-modal="true"
            aria-labelledby="mediation-prompt-title"
            aria-describedby="mediation-prompt-description"
          >
            <div className={styles.mediationPromptIcon} aria-hidden="true">↝</div>
            <div className={styles.mediationPromptEyebrow}>
              AI coordination request
            </div>
            <h2 id="mediation-prompt-title">This discussion seems stuck.</h2>
            <p id="mediation-prompt-description">
              The child topic <strong>{mediationCandidate.topic}</strong> has
              crossed the {Math.round(MEDIATION_CONTENTION_THRESHOLD * 100)}%
              contention threshold. A short private mediation can help clarify
              concerns before the group continues.
            </p>
            <div className={styles.mediationPromptStats}>
              <span>
                <small>Contention</small>
                <strong>{Math.round(mediationCandidate.contentionScore * 100)}%</strong>
              </span>
              <span>
                <small>Discussion loops</small>
                <strong>{mediationCandidate.discussionLoopCount}</strong>
              </span>
              <span>
                <small>Current state</small>
                <strong>Heated</strong>
              </span>
            </div>
            <div className={styles.mediationPrivacyNote}>
              <span aria-hidden="true">◇</span>
              Your conversation with the Private Agent is visible only to you.
            </div>
            <div className={styles.mediationPromptActions}>
              <button onClick={() => setMediationCandidate(null)}>Not now</button>
              <button className={styles.mediationPrimaryAction} onClick={enterMediation}>
                Agree and enter mediation <span aria-hidden="true">→</span>
              </button>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
