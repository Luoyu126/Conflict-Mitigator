"use client";

import { useCallback, useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { apiRequest } from "@/lib/api/client";
import type { MediationResolution } from "@/contracts/rooms";
import type { MediationMeData, PrivateMessagePage } from "@/contracts/mediation";

export default function MediationPage() {
  const { roomId, nodeId } = useParams<{ roomId: string; nodeId: string }>();
  const router = useRouter();
  const [resolution, setResolution] = useState<MediationResolution | null>(null);
  const [me, setMe] = useState<MediationMeData | null>(null);
  const [messages, setMessages] = useState<PrivateMessagePage | null>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const refresh = useCallback(async () => {
    try {
      const res = await apiRequest<MediationResolution>(`/api/rooms/${roomId}/nodes/${nodeId}/mediation`);
      setResolution(res.data);
      if (res.data.session) {
        const [meRes, msgRes] = await Promise.all([
          apiRequest<MediationMeData>(`/api/rooms/${roomId}/mediations/${res.data.session.id}/me`),
          apiRequest<PrivateMessagePage>(`/api/rooms/${roomId}/mediations/${res.data.session.id}/me/messages`),
        ]);
        setMe(meRes.data);
        setMessages(msgRes.data);
        if (meRes.data.session.status === "completed" || meRes.data.session.status === "cancelled") {
          router.push(`/room/${roomId}`);
        }
      }
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load mediation.");
    }
  }, [roomId, nodeId, router]);

  useEffect(() => {
    const first = setTimeout(() => { void refresh(); }, 0);
    const timer = setInterval(() => { void refresh(); }, 2500);
    return () => { clearTimeout(first); clearInterval(timer); };
  }, [refresh]);

  const send = async () => {
    if (!draft.trim() || !resolution?.session || !me?.chatAllowed) return;
    setBusy(true);
    setError("");
    try {
      await apiRequest(`/api/rooms/${roomId}/mediations/${resolution.session.id}/me/messages`, {
        method: "POST",
        body: JSON.stringify({ clientMessageId: crypto.randomUUID(), content: draft.trim() }),
      });
      setDraft("");
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to send.");
    } finally {
      setBusy(false);
    }
  };

  const resume = async () => {
    if (!resolution?.session || !me) return;
    setBusy(true);
    setError("");
    try {
      await apiRequest(`/api/rooms/${roomId}/mediations/${resolution.session.id}/resume`, {
        method: "POST",
        body: JSON.stringify({ decision: "accept", summaryVersion: me.session.summaryVersion }),
        idempotencyKey: crypto.randomUUID(),
      });
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to resume.");
    } finally {
      setBusy(false);
    }
  };

  const cancel = async () => {
    if (!resolution?.session) return;
    setBusy(true);
    setError("");
    try {
      await apiRequest(`/api/rooms/${roomId}/mediations/${resolution.session.id}/cancel`, {
        method: "POST",
        body: JSON.stringify({ reason: "Cancel" }),
        idempotencyKey: crypto.randomUUID(),
      });
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to cancel.");
    } finally {
      setBusy(false);
    }
  };

  if (!me) {
    return <main className="center shell"><div>{error || "Opening your private space…"}</div></main>;
  }

  return (
    <main className="shell">
      <div className="row" style={{ justifyContent: "space-between", marginBottom: 18 }}>
        <div className="brand"><span className="brand-mark">P</span> PulseMap</div>
        <span className="pill med">Private mediation · {me.node.topic}</span>
      </div>

      {error && <p className="error">{error}</p>}

      <div className="grid-2" style={{ alignItems: "start" }}>
        <div className="card col">
          <p className="section-title">Your private conversation</p>
          {!me.chatAllowed && <p className="muted" style={{ fontSize: 13 }}>Chat opens once media is isolated.</p>}
          <div className="chat">
            {messages?.items.map((m) => (
              <div key={m.id} className={`msg ${m.role}`}>{m.content}</div>
            ))}
            {messages && messages.items.length === 0 && <p className="muted" style={{ fontSize: 14 }}>Start by sharing what is at stake.</p>}
          </div>
          <div className="bar">
            <textarea
              className="input grow"
              rows={2}
              placeholder="What is really at stake?"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }}
            />
            <button className="btn btn-primary" onClick={send} disabled={busy || !me.chatAllowed}>Send</button>
          </div>
        </div>

        <div className="card col">
          <p className="section-title">Shared understanding</p>
          {me.consensusTree ? (
            <div className="list">
              {me.consensusTree.nodes.map((n) => (
                <div className="item" key={n.id}>
                  <div className="map-node">
                    <div style={{ fontWeight: 600 }}>{n.label}</div>
                    <div className="muted" style={{ fontSize: 12 }}>{n.kind.replace(/_/g, " ")} · {n.epistemicStatus.replace(/_/g, " ")}</div>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <p className="muted" style={{ fontSize: 14 }}>The shared tree forms as concerns clarify.</p>
          )}

          {me.session.sharedSummary && (
            <div className="card" style={{ background: "var(--panel-2)" }}>
              <p className="section-title">Shared summary · v{me.session.summaryVersion}</p>
              <p style={{ fontSize: 14, lineHeight: 1.5 }}>{me.session.sharedSummary}</p>
            </div>
          )}

          <div className="row">
            {me.canAcceptResume && <button className="btn btn-primary grow" onClick={resume} disabled={busy}>Accept and return to meeting</button>}
            <button className="btn btn-danger" onClick={cancel} disabled={busy}>Cancel mediation</button>
          </div>
        </div>
      </div>
    </main>
  );
}
