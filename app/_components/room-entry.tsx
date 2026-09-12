"use client";
import { useRef, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { apiRequest } from "@/lib/api/client";
import type { CreateRoomData } from "@/contracts/rooms";

export default function RoomEntry() {
  const router = useRouter();
  const [title, setTitle] = useState("");
  const [roomCode, setRoomCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const command = useRef<{ body: string; key: string } | null>(null);
  async function create(event: FormEvent) {
    event.preventDefault(); if (busy) return;
    const body = JSON.stringify({ title: title.trim() });
    if (command.current?.body !== body) command.current = { body, key: crypto.randomUUID() };
    setBusy(true); setError("");
    try {
      const { data } = await apiRequest<CreateRoomData>("/api/rooms", { method: "POST", body, idempotencyKey: command.current.key });
      router.push(data.lobbyPath);
    } catch (e) { setError(e instanceof Error ? e.message : "Could not create the meeting."); setBusy(false); }
  }
  function join(event: FormEvent) {
    event.preventDefault();
    const match = roomCode.trim().match(/(?:^|\/room\/)([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\/lobby)?\/?$/i);
    if (!match) { setError("Enter a meeting ID or meeting link."); return; }
    router.push(`/room/${match[1]}/lobby`);
  }
  return <div className="cm-entry">
    <form onSubmit={create} className="cm-form"><label htmlFor="meeting-title">Start a conversation</label>
      <input id="meeting-title" value={title} onChange={e => setTitle(e.target.value)} required maxLength={120} placeholder="Meeting title" />
      <button className="cm-primary" disabled={busy || !title.trim()}>{busy ? "Creating…" : "Create meeting"}</button>
    </form>
    <form onSubmit={join} className="cm-form"><label htmlFor="meeting-link">Join a conversation</label>
      <input id="meeting-link" value={roomCode} onChange={e => setRoomCode(e.target.value)} required placeholder="Meeting link or ID" />
      <button disabled={busy}>Join meeting</button>
    </form>
    {error && <p className="cm-error" role="alert">{error}</p>}
  </div>;
}
