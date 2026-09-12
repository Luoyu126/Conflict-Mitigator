"use client";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { apiRequest, ApiClientError } from "@/lib/api/client";
import type { LiveKitConnection, TokenData } from "@/contracts/media";
import type { SessionData } from "@/contracts/mediation";
import type { ConsentData, Consents, MindMapData, RoomData, TranscriptPage, TranscriptSegment, MediationResolution, MediationSession, NodeData } from "@/contracts/rooms";
import type { MindMapData as MapView, TranscriptData as TranscriptView } from "@/contracts/mind-map";
import { MeetingAudio } from "@/components/shared/meeting-audio";
import { useRoomRealtime } from "@/hooks/use-room-realtime";
import { useApiPoll } from "@/app/_components/use-api-poll";
import ConsentOptions from "@/app/_components/consent-options";
import MindMapWorkspace from "./mind-map-workspace";
import MeetingMedia from "./meeting-media";
import styles from "./mind-map-workspace.module.css";

export type LiveMeetingView = {
  room: RoomData; map: MapView; transcript: TranscriptView; notice: ReactNode;
  busy: boolean; consentPanel: ReactNode; transcriptTools: ReactNode; onLeave: () => void; onEnd: () => void;
  onSelectNode: (id: string) => void;
};
export function MeetingWorkspace({ view, participants, controls }: {
  view: LiveMeetingView; participants: ReactNode; controls: ReactNode;
}) {
  return <MindMapWorkspace roomId={view.room.room.id} mindMap={view.map} transcript={view.transcript}
    live={{ title: view.room.room.title, notice: view.notice, participants, controls, transcriptTools: view.transcriptTools, onSelectNode: view.onSelectNode }} />;
}
export default function LiveMeeting({ roomId }: { roomId: string }) {
  const router = useRouter();
  const [room, setRoom] = useState<RoomData | null>(null);
  const [map, setMap] = useState<MindMapData | null>(null);
  const [transcript, setTranscript] = useState<TranscriptPage | null>(null);
  const [olderSegments, setOlderSegments] = useState<TranscriptSegment[]>([]);
  const [olderCursor, setOlderCursor] = useState<string | null | undefined>(undefined);
  const [historyBusy, setHistoryBusy] = useState(false);
  const [session, setSession] = useState<MediationSession | null>(null);
  const [connection, setConnection] = useState<LiveKitConnection | null>(null);
  const [refresh, setRefresh] = useState(0);
  const [mediaAttempt, setMediaAttempt] = useState(0);
  const [error, setError] = useState("");
  const [mediaError, setMediaError] = useState("");
  const [busy, setBusy] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [controlFresh, setControlFresh] = useState(false);
  const [nodeDetail, setNodeDetail] = useState<NodeData | null>(null);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const mutation = useRef<{ operation: string; body: string; key: string } | null>(null);
  const invalidate = useCallback(() => setRefresh(value => value + 1), []);
  useRoomRealtime(roomId, room?.me.participant.id ?? null, invalidate);
  useApiPoll(async signal => {
    let verified = false;
    try {
      const { data } = await apiRequest<RoomData>(`/api/rooms/${roomId}`, { signal });
      if (signal.aborted) return;
      // Commit public-media gate before any secondary projection can fail.
      setRoom(data); setControlFresh(true); verified = true;
      let nextSession: MediationSession | null = null;
      if (data.room.activeMediationNodeId) {
        const result = await apiRequest<MediationResolution>(`/api/rooms/${roomId}/nodes/${data.room.activeMediationNodeId}/mediation`, { signal });
        nextSession = result.data.session;
      }
      if (signal.aborted) return;
      setSession(nextSession);
      if (nextSession?.status === "active") {
        router.replace(`/room/${roomId}/mediation/${nextSession.nodeId}`); return;
      }
      const [m, t] = await Promise.all([
        apiRequest<MindMapData>(`/api/rooms/${roomId}/mind-map`, { signal }),
        apiRequest<TranscriptPage>(`/api/rooms/${roomId}/transcripts?limit=100`, { signal }),
      ]);
      if (signal.aborted) return;
      setMap(m.data); setTranscript(t.data); setError("");
    } catch (e) {
      if (signal.aborted) return;
      setError(e instanceof Error ? e.message : "Could not refresh meeting.");
      if (!verified) setControlFresh(false);
      // Failed authorization or unknown state must never leave public capture running.
      if (e instanceof ApiClientError && [401, 403, 404].includes(e.status)) { setRoom(null); setConnection(null); }
    }
  }, `${roomId}:${refresh}`);

  useEffect(() => {
    if (!room) return;
    const timer = setTimeout(() => setControlFresh(false), 3500);
    return () => clearTimeout(timer);
  }, [room]);

  const publicMedia = Boolean(controlFresh && room && room.me.participant.status === "active" &&
    ["meeting", "lobby"].includes(room.room.status) && !["starting", "active"].includes(session?.status ?? "") && !leaving);
  const mediaBoundary = `${room?.room.status === "mediation" ? room.room.activeMediationSessionId : "public"}:${room?.room.status ?? "unknown"}`;
  useEffect(() => {
    const controller = new AbortController(); let timer: ReturnType<typeof setTimeout>;
    queueMicrotask(() => { if (!controller.signal.aborted) { setConnection(null); setMediaError(""); } });
    if (!publicMedia) return () => { controller.abort(); };
    async function connect() {
      try {
        const result = await apiRequest<TokenData>(`/api/rooms/${roomId}/livekit-token`, {
          method: "POST", body: "{}", signal: controller.signal,
        });
        if (controller.signal.aborted) return;
        setConnection(result.data.livekit); setMediaError("");
      } catch (e) {
        if (controller.signal.aborted) return;
        setMediaError(e instanceof Error ? e.message : "Meeting media is unavailable.");
        if (e instanceof ApiClientError && (e.detail.retryable || e.status === 409 || e.status === 429)) {
          timer = setTimeout(connect, Math.max(1000, e.detail.retryAfterMs ?? 1500));
        }
      }
    }
    void connect(); return () => { controller.abort(); clearTimeout(timer); };
  }, [roomId, publicMedia, mediaBoundary, mediaAttempt]);

  async function mutate<T = unknown>(operation: string, body: object) {
    const encoded = JSON.stringify(body);
    if (mutation.current?.operation !== operation || mutation.current.body !== encoded) {
      mutation.current = { operation, body: encoded, key: crypto.randomUUID() };
    }
    const result = await apiRequest<T>(operation, { method: "POST", body: encoded, idempotencyKey: mutation.current.key });
    mutation.current = null; return result;
  }
  async function exit(end: boolean) {
    if (busy) return; setBusy(true); setLeaving(true); setConnection(null); setError("");
    try { await mutate(`/api/rooms/${roomId}/${end ? "end" : "leave"}`, {}); router.push("/"); }
    catch (e) { setError(e instanceof Error ? e.message : "Could not leave meeting. Media remains stopped; retry leaving."); setBusy(false); }
  }
  async function decision(value: "accept" | "decline") {
    if (!session || busy) return; setBusy(true); setError("");
    try {
      const response = await mutate<SessionData>(`/api/rooms/${roomId}/mediations/${session.id}/acceptance`, { decision: value });
      setSession(response.data.session);
      setRoom(current => current ? { ...current, room: { ...current.room, status: response.data.roomStatus } } : current);
      if (response.data.session.status === "starting" || response.data.session.status === "active") setConnection(null);
      invalidate();
    }
    catch (e) { setError(e instanceof Error ? e.message : "Could not submit your decision."); }
    finally { setBusy(false); }
  }
  async function changeConsent(key: keyof Consents, value: boolean) {
    if (busy) return; setBusy(true); setError("");
    try {
      const result = await apiRequest<ConsentData>(`/api/rooms/${roomId}/me/consents`, { method: "PATCH", body: JSON.stringify({ [key]: value }) });
      setRoom(current => current ? { ...current, me: result.data.me } : current); invalidate();
    } catch (e) { setError(e instanceof Error ? e.message : "Could not update consent."); }
    finally { setBusy(false); }
  }
  useEffect(() => {
    if (!selectedNodeId) return;
    const controller = new AbortController();
    void apiRequest<NodeData>(`/api/rooms/${roomId}/nodes/${selectedNodeId}`, { signal: controller.signal })
      .then(result => { if (!controller.signal.aborted) setNodeDetail(result.data); })
      .catch(() => { if (!controller.signal.aborted) setNodeDetail(null); });
    return () => controller.abort();
  }, [roomId, selectedNodeId, map?.mapVersion]);

  const historyCursor = olderCursor === undefined ? transcript?.pageInfo.nextBeforeCursor : olderCursor;
  async function loadEarlier() {
    if (!historyCursor || historyBusy) return;
    setHistoryBusy(true);
    try {
      const response = await apiRequest<TranscriptPage>(`/api/rooms/${roomId}/transcripts?limit=100&before=${encodeURIComponent(historyCursor)}`);
      setOlderSegments(current => [...response.data.items, ...current]); setOlderCursor(response.data.pageInfo.nextBeforeCursor);
    } catch (e) { setError(e instanceof Error ? e.message : "Could not load earlier transcript."); }
    finally { setHistoryBusy(false); }
  }
  const allSegments = useMemo(() => Array.from(new Map([...olderSegments, ...(transcript?.items ?? [])].map(item => [item.id, item])).values())
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)), [olderSegments, transcript]);

  const viewMap = useMemo<MapView>(() => ({ roomId, updatedAt: room?.room.updatedAt ?? "", nodes: map?.nodes ?? [],
    mockMeta: { source: "authorized API", generatedFor: "live meeting", snapshotAtMs: 0, statusTransitionsAreSynthetic: false, notes: "" },
  }), [roomId, room?.room.updatedAt, map]);
  const viewTranscript = useMemo<TranscriptView>(() => ({ roomId, participants: room?.participants ?? [], mindMapEvents: [],
    mockMeta: { source: "authorized API", durationMs: 0, timingMode: "media epoch", contentMode: "browser final", statusTransitionsAreSynthetic: false, notes: "" },
    transcriptSegments: allSegments.map(segment => ({ ...segment,
      speaker: room?.participants.find(p => p.id === segment.participantId)?.displayName ?? "Participant",
      startedAtMs: segment.startedAtMs ?? 0, endedAtMs: segment.endedAtMs ?? 0, sourceParagraph: 0, timestampUnavailable: segment.startedAtMs === null,
    })),
  }), [roomId, room?.participants, allSegments]);

  if (!room) return <main className="cm-lobby"><div className="cm-card"><h1>Live Meeting</h1><p role="status">{error || "Opening your conversation…"}</p><Link href={`/room/${roomId}/lobby`}>Go to Meeting Lobby</Link></div></main>;
  const notice = <>
    {(error || mediaError) && <div className="cm-room-notice cm-error" role="alert">{error || mediaError}
      {publicMedia && !connection && <button className="cm-action" onClick={() => setMediaAttempt(v => v + 1)}>Retry media connection</button>}
    </div>}
    {room.room.status === "ended" && <div className="cm-room-notice">This meeting has ended. Your camera and microphone are off. <Link href="/">Return home</Link></div>}
    {session?.status === "proposed" && <div className="cm-room-notice" role="status"><strong>This discussion seems stuck.</strong> A short private mediation can help clarify concerns before the group continues. Everyone must agree.
      <div>{session.members.filter(m => m.entryDecision === "accept").length} / {session.members.length} accepted</div>
      <button className="cm-action" disabled={busy || session.members.find(m => m.participantId === room.me.participant.id)?.entryDecision === "accept"} onClick={() => void decision("accept")}>Agree and enter mediation →</button>
      <button className="cm-action" disabled={busy} onClick={() => void decision("decline")}>Not now</button>
    </div>}
    {(room.room.status === "mediation" || session?.status === "starting") && <div className="cm-room-notice" role="status">Meeting media is off. Waiting for everyone’s media to be isolated before private mediation opens.</div>}
    {nodeDetail && nodeDetail.node.id === selectedNodeId && <details className="cm-room-notice"><summary>{nodeDetail.node.topic} · Shared perspectives</summary>
      <p>{nodeDetail.node.summary || "The meeting agent has not provided a summary yet."}</p>
      {nodeDetail.participantStates.map(state => <p key={state.id}><strong>{room.participants.find(p => p.id === state.participantId)?.displayName ?? "Participant"}</strong>: {state.position ?? "No shared position yet."}</p>)}
    </details>}
  </>;
  const consentPanel = <details><summary>Privacy & analysis choices</summary><ConsentOptions value={room.me.consents} disabled={busy || room.room.status === "ended" || room.me.participant.status !== "active"} onChange={(key, value) => void changeConsent(key, value)} /></details>;
  const transcriptTools = historyCursor && <button className="cm-action" disabled={historyBusy} onClick={() => void loadEarlier()}>{historyBusy ? "Loading…" : "Load earlier transcript"}</button>;
  const view: LiveMeetingView = { transcriptTools, room, map: viewMap, transcript: viewTranscript, notice, busy, consentPanel,
    onLeave: () => void exit(false), onEnd: () => void exit(true), onSelectNode: setSelectedNodeId };
  if (publicMedia && connection) return <MeetingAudio connection={connection} onDisconnected={() => { setConnection(null); setMediaAttempt(v => v + 1); }} onError={() => setMediaError("The media connection failed. Retry to obtain a fresh connection.")}>
    <MeetingMedia view={view} />
  </MeetingAudio>;
  return <MeetingWorkspace view={view}
    participants={<>{room.participants.filter(p => p.status === "active").map(p => <div className="cm-participant-tile" key={p.id}><div className="cm-participant-avatar">{p.displayName.slice(0, 2)}</div><strong>{p.displayName}</strong><small>Media off</small></div>)}<div className="cm-self-controls">{consentPanel}</div></>}
    controls={<><div className={styles.controlGroup}><button disabled>♩ Microphone off</button><button disabled>▰ Camera off</button></div><span>{publicMedia ? "Connecting media…" : "Media stopped"}</span><button className={styles.leaveButton} disabled={busy} onClick={view.onLeave}>Leave</button></>} />;
}
