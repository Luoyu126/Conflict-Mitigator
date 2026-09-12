"use client";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { apiRequest, ApiClientError } from "@/lib/api/client";
import type { MediationResolution, RoomData, ConsentData } from "@/contracts/rooms";
import type { MediationMeData, PrivateMessage, PrivateMessagePage } from "@/contracts/mediation";
import { useApiPoll } from "@/app/_components/use-api-poll";
import { useRoomRealtime } from "@/hooks/use-room-realtime";
import styles from "./mediation-room.module.css";

export default function LiveMediation({ roomId, nodeId }: { roomId: string; nodeId: string }) {
  const router = useRouter();
  const [room, setRoom] = useState<RoomData | null>(null);
  const [me, setMe] = useState<MediationMeData | null>(null);
  const [messages, setMessages] = useState<PrivateMessagePage | null>(null);
  const [olderMessages, setOlderMessages] = useState<PrivateMessage[]>([]);
  const [historyCursor, setHistoryCursor] = useState<string | null | undefined>(undefined);
  const [historyBusy, setHistoryBusy] = useState(false);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [refresh, setRefresh] = useState(0);
  const [now, setNow] = useState(0);
  const currentSession = useRef<string | null>(null);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const sendCommand = useRef<{ content: string; id: string } | null>(null);
  const decisionCommand = useRef<{ path: string; body: string; id: string } | null>(null);
  const invalidate = useCallback(() => setRefresh(v => v + 1), []);
  useRoomRealtime(roomId, room?.me.participant.id ?? null, invalidate);
  useApiPoll(async signal => {
    try {
      const roomResponse = await apiRequest<RoomData>(`/api/rooms/${roomId}`, { signal });
      if (signal.aborted) return;
      setRoom(roomResponse.data);
      if (roomResponse.data.room.status === "ended" || roomResponse.data.me.participant.status === "left") { router.replace(`/room/${roomId}`); return; }
      const resolution = await apiRequest<MediationResolution>(`/api/rooms/${roomId}/nodes/${nodeId}/mediation`, { signal });
      if (signal.aborted) return;
      if (!resolution.data.session || ["completed", "cancelled"].includes(resolution.data.session.status)) { router.replace(`/room/${roomId}`); return; }
      if (!resolution.data.isMember) { setError("You are not a member of this private mediation."); setMe(null); return; }
      const path = `/api/rooms/${roomId}/mediations/${resolution.data.session.id}/me`;
      const response = await apiRequest<MediationMeData>(path, { signal });
      if (signal.aborted) return;
      if (currentSession.current !== response.data.session.id) {
        currentSession.current = response.data.session.id;
        setMessages(null); setOlderMessages([]); setHistoryCursor(undefined); setDraft("");
        sendCommand.current = null; decisionCommand.current = null;
      }
      setMe(response.data);
      if (["completed", "cancelled"].includes(response.data.session.status)) { router.replace(response.data.navigationPath); return; }
      if (response.data.session.status === "active") {
        const history = await apiRequest<PrivateMessagePage>(`${path}/messages?limit=100`, { signal });
        if (signal.aborted) return; setMessages(history.data);
      }
      setError("");
    } catch (e) { if (!signal.aborted) {
      setError(e instanceof Error ? e.message : "Could not load your private mediation.");
      if (e instanceof ApiClientError && [401, 403, 404].includes(e.status)) { setMe(null); setMessages(null); setOlderMessages([]); }
    } }
  }, `${roomId}:${nodeId}:${refresh}`);

  async function action(path: string, data: object) {
    if (busy) return; setBusy(true); setError("");
    const body = JSON.stringify(data);
    if (decisionCommand.current?.path !== path || decisionCommand.current.body !== body) decisionCommand.current = { path, body, id: crypto.randomUUID() };
    try { await apiRequest(path, { method: "POST", body, idempotencyKey: decisionCommand.current.id }); decisionCommand.current = null; invalidate(); }
    catch (e) { setError(e instanceof Error ? e.message : "Could not submit your decision."); }
    finally { setBusy(false); }
  }
  async function send(event?: FormEvent, retry?: PrivateMessage) {
    event?.preventDefault();
    const content = retry?.content ?? draft.trim();
    if (!content || busy || !me?.chatAllowed) return;
    if (retry?.clientMessageId) sendCommand.current = { content, id: retry.clientMessageId };
    else if (sendCommand.current?.content !== content) sendCommand.current = { content, id: crypto.randomUUID() };
    setBusy(true); setError("");
    try {
      await apiRequest(`/api/rooms/${roomId}/mediations/${me.session.id}/me/messages`, {
        method: "POST", body: JSON.stringify({ content, clientMessageId: sendCommand.current!.id }),
      });
      if (!retry) setDraft(""); sendCommand.current = null; invalidate();
    } catch (e) { setError(e instanceof Error ? e.message : "Your message could not be delivered. Retry sends the same message once."); }
    finally { setBusy(false); }
  }
  async function enableSharing() {
    if (busy) return; setBusy(true); setError("");
    try {
      const response = await apiRequest<ConsentData>(`/api/rooms/${roomId}/me/consents`, { method: "PATCH", body: JSON.stringify({ structuredSharing: true }) });
      setRoom(current => current ? { ...current, me: response.data.me } : current); invalidate();
    } catch (e) { setError(e instanceof Error ? e.message : "Could not update your choice."); }
    finally { setBusy(false); }
  }
  const earlierCursor = historyCursor === undefined ? messages?.pageInfo.nextBeforeCursor : historyCursor;
  async function loadEarlier() {
    if (!earlierCursor || !me || historyBusy) return; setHistoryBusy(true);
    try {
      const response = await apiRequest<PrivateMessagePage>(`/api/rooms/${roomId}/mediations/${me.session.id}/me/messages?limit=100&before=${encodeURIComponent(earlierCursor)}`);
      setOlderMessages(current => [...response.data.items, ...current]); setHistoryCursor(response.data.pageInfo.nextBeforeCursor);
    } catch (e) { setError(e instanceof Error ? e.message : "Could not load earlier messages."); }
    finally { setHistoryBusy(false); }
  }
  const allMessages = Array.from(new Map([...olderMessages, ...(messages?.items ?? [])].map(item => [item.id, item])).values())
    .filter(message => now < Date.parse(message.createdAt) + 24 * 60 * 60 * 1000)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  const session = me?.session;
  const phase = !session || session.status !== "active" ? 0 : me?.canAcceptResume ? 3 : me?.consensusTree ? 2 : 1;
  const myMember = session?.members.find(member => member.participantId === room?.me.participant.id);
  const base = `/api/rooms/${roomId}/mediations/${session?.id}`;
  return <div className={`${styles.roomShell} ${styles.liveRoomShell}`}>
    <header className={styles.roomHeader}><div className={styles.brand}><span className={styles.brandMark}>CM</span><span><strong>Private Mediation</strong><small>Private conversation · AI guided</small></span></div>
      <div className={styles.topicBreadcrumb}><span>Child topic</span><strong>{me?.node.topic ?? "Opening your private space…"}</strong></div>
      <button className={styles.exitLink} disabled={!session || busy} onClick={() => void action(`${base}/cancel`, { reason: "Participant requested to end private mediation." })}>Exit private room</button>
    </header>
    <div className={styles.privacyBanner} role="note"><span className={styles.lockIcon}>◇</span><p><strong>This conversation is private.</strong> Your messages are visible only to you and your Private Agent. Only structured concerns and agreed common ground are shared. Public camera, microphone, transcription and emotion analysis are off.</p><span className={styles.privateBadge}>Private text</span></div>
    {error && <div className="cm-room-notice cm-error" role="alert">{error}</div>}
    <main className={styles.mediationBody}>
      <aside className={styles.contextPanel}><div className={styles.contextEyebrow}>Mediation topic</div><h1>{me?.node.topic ?? "Private Mediation"}</h1><p>{me?.node.summary ?? "Waiting for the meeting’s mediation state."}</p>
        <div className={styles.signalCard}><div><span>Contention detected</span><strong>{me ? `${Math.round(me.node.contentionScore * 100)}%` : "—"}</strong></div><div className={styles.meter}><i style={{ width: `${(me?.node.contentionScore ?? 0) * 100}%` }} /></div><small>{me?.node.discussionLoopCount ?? 0} repeated loops</small></div>
        <div className={styles.sessionTimeline}>{["Media isolation", "Clarify concerns", "Compare", "Common ground"].map((label, index) => <div key={label} className={index < phase ? styles.stepDone : index === phase ? styles.stepActive : ""}><i>{index < phase ? "✓" : index + 1}</i><span>{label}</span></div>)}</div>
        <div className={styles.readinessCard}><div><span>Readiness to resume</span><strong>{me?.node.readinessScore == null ? "—" : `${Math.round(me.node.readinessScore * 100)}%`}</strong></div><div className={styles.readinessMeter}><i style={{ width: `${(me?.node.readinessScore ?? 0) * 100}%` }} /></div></div>
        <p>Your Private Agent helps identify the concern underneath your position.</p>
      </aside>
      <section className={styles.voicePanel} aria-label="Your private conversation"><header className={styles.voiceHeader}><div><i /> Private conversation</div><span>{session?.status ?? "Loading"}</span></header>
        {session?.status === "proposed" && <div className="cm-room-notice"><p>Everyone must agree before private mediation starts.</p><button className="cm-action" disabled={busy || myMember?.entryDecision === "accept"} onClick={() => void action(`${base}/acceptance`, { decision: "accept" })}>Agree and enter mediation →</button><button className="cm-action" disabled={busy} onClick={() => void action(`${base}/acceptance`, { decision: "decline" })}>Not now</button></div>}
        {session?.status === "starting" && <div className="cm-room-notice" role="status">Waiting for everyone’s shared media to stop…</div>}
        {session?.transitionError && <div className="cm-room-notice" role="status">{session.transitionError}</div>}
        {session?.status === "active" && !room?.me.consents.structuredSharing && <div className="cm-room-notice"><p>Private chat requires your choice to share structured concerns. Your exact messages remain private.</p><button className="cm-action" disabled={busy} onClick={() => void enableSharing()}>Allow structured sharing</button></div>}
        <div className="cm-messages" aria-live="polite" role="log" aria-label="Private messages">
          {earlierCursor && <button className="cm-action" disabled={historyBusy} onClick={() => void loadEarlier()}>Load earlier messages</button>}
          {allMessages.length ? allMessages.map(message => <article className="cm-message" data-role={message.role} key={message.id}><small>{message.role === "user" ? "You" : "Private Agent"}</small>{message.content}
            {message.role === "user" && message.replyStatus !== "completed" && <div><small>{message.replyStatus === "failed" ? "The agent could not complete its reply." : "Waiting for the agent’s reply…"}</small><button className="cm-action" disabled={busy || !me?.chatAllowed} onClick={() => void send(undefined, message)}>Retry reply</button></div>}
          </article>) : <p>{me?.chatAllowed ? "Start by sharing what is at stake." : "Private chat opens after media isolation and your sharing choice."}</p>}
        </div>
        <form className="cm-form cm-chat-compose" onSubmit={event => void send(event)}><label htmlFor="private-message">Your message to the Private Agent</label><textarea id="private-message" rows={3} maxLength={4000} value={draft} disabled={!me?.chatAllowed || busy} onChange={event => setDraft(event.target.value)} placeholder="What is really at stake?" /><button className="cm-primary" disabled={busy || !me?.chatAllowed || !draft.trim()}>{busy ? "Working…" : "Send"}</button></form>
      </section>
      <aside className={styles.outcomePanel} aria-label="Participant concerns and common ground"><header><span>Structured outcome</span><strong>{me?.canAcceptResume ? "Ready to share" : "Finding alignment…"}</strong></header>
        <div className={styles.concernGrid}>{me?.others.map(state => <section className={`${styles.concernBlock} ${styles.blockRevealed}`} key={state.id}><div className={styles.participantTitle}><span>{(room?.participants.find(p => p.id === state.participantId)?.displayName ?? "P").slice(0, 2)}</span><div><strong>{room?.participants.find(p => p.id === state.participantId)?.displayName ?? "Participant"}</strong><small>Shared perspective</small></div></div><div className={styles.blockLabel}>Primary concern</div><p>{state.underlyingConcerns.join(" · ") || state.position || "No structured perspective has been shared."}</p></section>)}</div>
        <section className={`${styles.commonGroundBlock} ${me?.canAcceptResume ? styles.commonGroundRevealed : ""}`}><div className={styles.commonGroundHeading}><span>✓</span><div><small>Common ground</small><strong>{me?.canAcceptResume ? "Ready for your decision" : "Comparing concerns"}</strong></div></div>
          {me?.consensusTree ? <div aria-label="Shared consensus tree">{me.consensusTree.nodes.map(node => <div className="cm-consensus-node" key={node.id}>{node.label}<small>{node.kind.replaceAll("_", " ")} · {node.epistemicStatus.replaceAll("_", " ")}</small>{me.consensusTree!.edges.filter(edge => edge.sourceNodeId === node.id).map(edge => <small key={edge.id}>{edge.relation.replaceAll("_", " ")} → {me.consensusTree!.nodes.find(target => target.id === edge.targetNodeId)?.label ?? "Related concern"}</small>)}</div>)}</div> : <p>The shared tree forms as concerns clarify.</p>}
          {session?.sharedSummary && <div className={styles.nextStep}><span>Shared summary · version {session.summaryVersion}</span><strong>{session.sharedSummary}</strong></div>}
          {me?.canAcceptResume && <><p>Everyone must accept this version before shared media resumes.</p><button disabled={busy || (myMember?.resumeDecision === "accept" && myMember.acceptedSummaryVersion === session?.summaryVersion)} onClick={() => void action(`${base}/resume`, { decision: "accept", summaryVersion: me.session.summaryVersion })}>Accept and return to meeting →</button><button disabled={busy} onClick={() => void action(`${base}/resume`, { decision: "wait", summaryVersion: me.session.summaryVersion })}>I need more time</button></>}
          {myMember?.resumeDecision === "accept" && <p role="status">Your acceptance is recorded. Waiting for everyone to accept the same summary version.</p>}
        </section>
      </aside>
    </main>
  </div>;
}
