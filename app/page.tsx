"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { apiRequest } from "@/lib/api/client";

export default function HomePage() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [code, setCode] = useState("");

  const create = async () => {
    setBusy(true);
    setError("");
    try {
      const res = await apiRequest<{ room: { id: string } }>("/api/rooms", {
        method: "POST",
        body: JSON.stringify({ title: "PulseMap meeting" }),
        idempotencyKey: crypto.randomUUID(),
      });
      router.push(`/room/${res.data.room.id}/lobby`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to create the room.");
    } finally {
      setBusy(false);
    }
  };

  const join = () => {
    const cleaned = code.trim().split("/").filter(Boolean).at(-1);
    if (cleaned) router.push(`/room/${cleaned}/lobby`);
  };

  return (
    <main className="shell">
      <div className="brand"><span className="brand-mark">P</span> PulseMap</div>
      <div style={{ marginTop: 72, maxWidth: 560 }}>
        <h1 className="h1">Find the issue.<br />Not a side.</h1>
        <p className="muted" style={{ fontSize: 17, lineHeight: 1.6 }}>
          A live discussion map, private AI mediation, and a shared path back to the room.
        </p>
        <div className="col" style={{ marginTop: 28 }}>
          <button className="btn btn-primary" onClick={create} disabled={busy}>
            {busy ? "Creating…" : "Start a meeting"}
          </button>
          <div className="bar">
            <input
              className="input grow"
              placeholder="Paste a room code or link"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && join()}
            />
            <button className="btn" onClick={join}>Join</button>
          </div>
          {error && <p className="error">{error}</p>}
        </div>
      </div>
    </main>
  );
}
