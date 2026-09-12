"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { apiRequest } from "@/lib/api/client";
import type { JoinData, LobbyData } from "@/contracts/rooms";

export default function LobbyPage() {
  const { roomId } = useParams<{ roomId: string }>();
  const router = useRouter();
  const [lobby, setLobby] = useState<LobbyData | null>(null);
  const [name, setName] = useState("");
  const [transcription, setTranscription] = useState(true);
  const [sharing, setSharing] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    apiRequest<LobbyData>(`/api/rooms/${roomId}/lobby`)
      .then((res) => setLobby(res.data))
      .catch((e) => setError(e instanceof Error ? e.message : "Failed to load."));
  }, [roomId]);

  const join = async () => {
    setBusy(true);
    setError("");
    try {
      const res = await apiRequest<JoinData>(`/api/rooms/${roomId}/join`, {
        method: "POST",
        body: JSON.stringify({
          displayName: name.trim() || "Guest",
          consents: { transcription, visualAffect: false, structuredSharing: sharing },
          consentNoticeVersion: "cm-privacy-v1",
        }),
        idempotencyKey: crypto.randomUUID(),
      });
      sessionStorage.setItem(`pulsemap:livekit:${roomId}`, JSON.stringify(res.data.livekit));
      router.push(`/room/${roomId}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to join.");
    } finally {
      setBusy(false);
    }
  };

  if (!lobby) {
    return <main className="center shell"><div>{error || "Loading room…"}</div></main>;
  }

  return (
    <main className="shell">
      <div className="brand"><span className="brand-mark">P</span> PulseMap</div>
      <div style={{ maxWidth: 480, margin: "48px auto 0" }}>
        <div className="card">
          <h2 className="h2">{lobby.title}</h2>
          <p className="muted" style={{ fontSize: 14 }}>
            {lobby.participantCount} connected · Room {lobby.roomId.slice(0, 8)}
          </p>
          <div className="col" style={{ marginTop: 16 }}>
            <div>
              <label className="label" htmlFor="name">Your name</label>
              <input id="name" className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Guest" />
            </div>
            <label className="check">
              <input type="checkbox" checked={transcription} onChange={(e) => setTranscription(e.target.checked)} />
              <span>Allow live transcription of my microphone</span>
            </label>
            <label className="check">
              <input type="checkbox" checked={sharing} onChange={(e) => setSharing(e.target.checked)} />
              <span>Allow structured sharing from private mediation (never raw messages)</span>
            </label>
            <button className="btn btn-primary" onClick={join} disabled={busy || !lobby.canJoin}>
              {busy ? "Joining…" : "Join meeting"}
            </button>
            {!lobby.canJoin && <p className="muted" style={{ fontSize: 13 }}>Media is isolated during mediation.</p>}
            {error && <p className="error">{error}</p>}
          </div>
        </div>
      </div>
    </main>
  );
}
