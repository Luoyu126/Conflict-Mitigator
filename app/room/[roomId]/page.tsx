"use client";

import { useCallback, useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { apiRequest } from "@/lib/api/client";
import { MeetingAudio } from "@/components/shared/meeting-audio";
import type { LiveKitConnection } from "@/contracts/media";
import type { MindMapData, RoomData, TranscriptPage } from "@/contracts/rooms";
import type { SessionData } from "@/contracts/mediation";

const accentFor = (id: string) => {
  const colors = ["#4fd1c0", "#a991ff", "#ffb86b", "#ff6f75"];
  const code = [...id].reduce((sum, ch) => sum + ch.charCodeAt(0), 0);
  return colors[code % colors.length];
};

export default function MeetingPage() {
  const { roomId } = useParams<{ roomId: string }>();
  const router = useRouter();
  const [room, setRoom] = useState<RoomData | null>(null);
  const [map, setMap] = useState<MindMapData | null>(null);
  const [transcripts, setTranscripts] = useState<TranscriptPage | null>(null);
  const [mediation, setMediation] = useState<SessionData | null>(null);
  const [livekit, setLivekit] = useState<LiveKitConnection | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const refresh = useCallback(async () => {
    try {
      const [r, m, t] = await Promise.all([
        apiRequest<RoomData>(`/api/rooms/${roomId}`),
        apiRequest<MindMapData>(`/api/rooms/${roomId}/mind-map`),
        apiRequest<TranscriptPage>(`/api/rooms/${roomId}/transcripts`),
      ]);
      setRoom(r.data);
      setMap(m.data);
      setTranscripts(t.data);
      setError("");
      const nodeId = r.data.room.activeMediationNodeId;
      if (nodeId) {
        const med = await apiRequest<{ session: SessionData["session"] | null }>(`/api/rooms/${roomId}/nodes/${nodeId}/mediation`);
        const node = m.data.nodes.find((n) => n.id === nodeId);
        if (med.data.session && node) {
          setMediation({ session: med.data.session, node, roomStatus: r.data.room.status });
        }
      } else {
        setMediation(null);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load the room.");
    }
  }, [roomId]);

  useEffect(() => {
    const first = setTimeout(() => { void refresh(); }, 0);
    const timer = setInterval(() => { void refresh(); }, 3000);
    return () => { clearTimeout(first); clearInterval(timer); };
  }, [refresh]);

  useEffect(() => {
    const timer = setTimeout(() => {
      const raw = sessionStorage.getItem(`pulsemap:livekit:${roomId}`);
      if (raw) {
        try { setLivekit(JSON.parse(raw) as LiveKitConnection); } catch { /* ignore */ }
      }
    }, 0);
    return () => clearTimeout(timer);
  }, [roomId]);

  const propose = async () => {
    if (!room || !map) return;
    const heated = map.nodes.find((n) => n.status === "heated");
    if (!heated) return;
    setBusy(true);
    setError("");
    try {
      await apiRequest(`/api/rooms/${roomId}/nodes/${heated.id}/mediation`, {
        method: "POST",
        body: JSON.stringify({ participantIds: room.participants.map((p) => p.id), reason: "Discussion is looping." }),
        idempotencyKey: crypto.randomUUID(),
      });
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to propose mediation.");
    } finally {
      setBusy(false);
    }
  };

  const decide = async (decision: "accept" | "decline") => {
    const sessionId = room?.room.activeMediationSessionId;
    if (!sessionId) return;
    setBusy(true);
    setError("");
    try {
      await apiRequest(`/api/rooms/${roomId}/mediations/${sessionId}/acceptance`, {
        method: "POST",
        body: JSON.stringify({ decision }),
        idempotencyKey: crypto.randomUUID(),
      });
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to record decision.");
    } finally {
      setBusy(false);
    }
  };

  if (!room) {
    return <main className="center shell"><div>{error || "Joining the room…"}</div></main>;
  }

  const heated = map?.nodes.find((n) => n.status === "heated");
  const session = mediation?.session;
  const canEnter = session?.status === "active";
  const canDecide = session?.status === "proposed";

  return (
    <main className="shell">
      <div className="row" style={{ justifyContent: "space-between", marginBottom: 18 }}>
        <div className="brand"><span className="brand-mark">P</span> PulseMap</div>
        <div className="row">
          <span className="pill">{room.room.status}</span>
          <span className="pill">{room.participants.length} connected</span>
        </div>
      </div>

      {error && <p className="error">{error}</p>}

      <div className="grid-3" style={{ alignItems: "start" }}>
        <div className="card col">
          <p className="section-title">Participants</p>
          <MeetingAudio connection={livekit} enabled={!room.me.participant ? false : room.me.consents.transcription}>
            <div className="list">
              {room.participants.map((p) => (
                <div className="item" key={p.id}>
                  <div className="row">
                    <span className="avatar" style={{ background: accentFor(p.id) }}>{p.displayName.slice(0, 1).toUpperCase()}</span>
                    <div>
                      <div style={{ fontWeight: 600 }}>{p.displayName}</div>
                      <div className="muted" style={{ fontSize: 12 }}>{p.role}</div>
                    </div>
                  </div>
                  <span className={`pill ${p.status === "active" ? "ok" : ""}`}>{p.status}</span>
                </div>
              ))}
            </div>
          </MeetingAudio>
        </div>

        <div className="card col">
          <p className="section-title">Discussion map</p>
          {map && map.nodes.length === 0 && <p className="muted" style={{ fontSize: 14 }}>No topics yet. Speak to grow the map.</p>}
          <div className="list">
            {map?.nodes.map((n) => (
              <div className="item" key={n.id}>
                <div className="map-node">
                  <div style={{ fontWeight: 600 }}>{n.topic}</div>
                  <div className="muted" style={{ fontSize: 12 }}>{Math.round(n.contentionScore * 100)}% contention</div>
                </div>
                <span className={`pill ${n.status === "heated" ? "hot" : n.status === "private_mediation" || n.status === "ready_to_resume" ? "med" : "ok"}`}>{n.status}</span>
              </div>
            ))}
          </div>
        </div>

        <div className="card col">
          <p className="section-title">Transcript</p>
          <div className="list" style={{ maxHeight: 320, overflowY: "auto" }}>
            {transcripts?.items.map((t) => (
              <div className="item" key={t.id}>
                <div style={{ fontSize: 14 }}>{t.content}</div>
                <span className="muted" style={{ fontSize: 12 }}>{t.participantId.slice(0, 8)}</span>
              </div>
            ))}
            {transcripts && transcripts.items.length === 0 && <p className="muted" style={{ fontSize: 14 }}>Nothing transcribed yet.</p>}
          </div>
        </div>
      </div>

      <div className="card row" style={{ marginTop: 18, justifyContent: "space-between" }}>
        <div>
          {session ? (
            <>
              <div style={{ fontWeight: 600 }}>Mediation {session.status}</div>
              <div className="muted" style={{ fontSize: 13 }}>{session.members.length} member{session.members.length === 1 ? "" : "s"} · node {mediation?.node.topic}</div>
            </>
          ) : heated ? (
            <div>
              <div style={{ fontWeight: 600 }}>Tension rising on “{heated.topic}”</div>
              <div className="muted" style={{ fontSize: 13 }}>Propose a private reset for the group.</div>
            </div>
          ) : (
            <div className="muted">No active conflict detected.</div>
          )}
        </div>
        <div className="row">
          {!session && heated && <button className="btn btn-primary" onClick={propose} disabled={busy}>Propose mediation</button>}
          {canDecide && session && (
            <>
              <button className="btn" onClick={() => decide("accept")} disabled={busy}>Accept</button>
              <button className="btn btn-danger" onClick={() => decide("decline")} disabled={busy}>Decline</button>
            </>
          )}
          {session?.status === "starting" && <span className="muted">Isolating media…</span>}
          {canEnter && <button className="btn btn-primary" onClick={() => router.push(`/room/${roomId}/mediation/${mediation?.node.id}`)}>Enter mediation</button>}
        </div>
      </div>
    </main>
  );
}
