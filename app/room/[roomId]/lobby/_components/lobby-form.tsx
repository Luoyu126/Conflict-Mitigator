"use client";
import { useEffect, useRef, useState, type FormEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { apiRequest } from "@/lib/api/client";
import { CONSENT_NOTICE_VERSION, type JoinData, type LobbyData } from "@/contracts/rooms";
import ConsentOptions, { EMPTY_CONSENTS } from "@/app/_components/consent-options";

export default function LobbyForm({ roomId }: { roomId: string }) {
  const router = useRouter();
  const [lobby, setLobby] = useState<LobbyData | null>(null);
  const [name, setName] = useState("");
  const [consents, setConsents] = useState(EMPTY_CONSENTS);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const command = useRef<{ body: string; key: string } | null>(null);
  useEffect(() => {
    const controller = new AbortController(); let timer: ReturnType<typeof setTimeout>;
    async function refresh() {
      try { const response = await apiRequest<LobbyData>(`/api/rooms/${roomId}/lobby`, { signal: controller.signal }); if (!controller.signal.aborted) setLobby(response.data); }
      catch (e) { if (!controller.signal.aborted) setError(e instanceof Error ? e.message : "Could not load meeting."); }
      finally { if (!controller.signal.aborted) timer = setTimeout(refresh, 1000); }
    }
    void refresh(); return () => { controller.abort(); clearTimeout(timer); };
  }, [roomId]);
  async function join(event: FormEvent) {
    event.preventDefault(); if (busy) return;
    const body = JSON.stringify({ displayName: name.trim(), consents, consentNoticeVersion: CONSENT_NOTICE_VERSION });
    if (command.current?.body !== body) command.current = { body, key: crypto.randomUUID() };
    setBusy(true); setError("");
    try {
      const { data } = await apiRequest<JoinData>(`/api/rooms/${roomId}/join`, { method: "POST", body, idempotencyKey: command.current.key });
      // Tokens remain in memory; the meeting obtains API-05 credentials on every entry.
      router.push(data.navigationPath);
    } catch (e) { setError(e instanceof Error ? e.message : "Could not join meeting."); setBusy(false); }
  }
  return <main className="cm-lobby"><div className="cm-card">
    <Link href="/" className="cm-wordmark">Conflict Mitigator</Link>
    <h1>Meeting Lobby</h1><h2>{lobby?.title ?? "Opening your conversation…"}</h2>
    {lobby && <p>{lobby.participantCount} participants · {lobby.status}</p>}
    <form className="cm-form" onSubmit={join}>
      <label htmlFor="display-name">Your name</label><input id="display-name" autoComplete="name" maxLength={40} required value={name} onChange={e => setName(e.target.value)} />
      <ConsentOptions value={consents} onChange={(key, value) => setConsents(current => ({ ...current, [key]: value }))} disabled={busy} />
      <p>Your camera and microphone start off. Turn them on from the meeting controls when you are ready.</p>
      <button className="cm-primary" disabled={busy || !lobby?.canJoin || !name.trim()}>{busy ? "Joining…" : "Join meeting"}</button>
      {lobby && !lobby.canJoin && <p role="status">{lobby.status === "ended" ? "This meeting has ended." : "Joining is paused while the meeting is in private mediation."}</p>}
    </form>{error && <p className="cm-error" role="alert">{error}</p>}
    {lobby?.myParticipantId && <Link href={`/room/${roomId}`}>Return to your meeting →</Link>}
  </div></main>;
}
