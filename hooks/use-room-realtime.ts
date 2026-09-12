"use client";
import { useEffect, useRef, useState } from "react";
import type { RealtimePostgresInsertPayload } from "@supabase/supabase-js";
import { roomEventSchema, type RoomEvent, type RoomPresence } from "../contracts/realtime";
import { getBrowserSupabase } from "../lib/supabase/client";

export type RoomRealtimeState = { connected: boolean; onlineParticipantIds: string[]; lastEvent: RoomEvent | null };

/** Realtime invalidates API projections; Presence contains only ephemeral IDs. */
export function useRoomRealtime(roomId: string | null, participantId: string | null, onInvalidate: (event: RoomEvent) => void): RoomRealtimeState {
  const callback = useRef(onInvalidate);
  const [state, setState] = useState<RoomRealtimeState>({ connected: false, onlineParticipantIds: [], lastEvent: null });
  useEffect(() => { callback.current = onInvalidate; }, [onInvalidate]);
  useEffect(() => {
    if (!roomId || !participantId) return;
    let client;
    try { client = getBrowserSupabase(); } catch { return; }
    let stopped = false;
    const channel = client.channel(`room:${roomId}`, { config: { presence: { key: participantId } } });
    const syncPresence = () => {
      if (stopped) return;
      const ids = new Set<string>();
      for (const entries of Object.values(channel.presenceState<RoomPresence>())) {
        for (const entry of entries) if (typeof entry.participantId === "string") ids.add(entry.participantId);
      }
      setState((current) => ({ ...current, onlineParticipantIds: [...ids].sort() }));
    };
    channel.on("presence", { event: "sync" }, syncPresence)
      .on("presence", { event: "join" }, syncPresence)
      .on("presence", { event: "leave" }, syncPresence)
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "room_events", filter: `room_id=eq.${roomId}` },
        (payload: RealtimePostgresInsertPayload<Record<string, unknown>>) => {
          if (stopped) return;
          const parsed = roomEventSchema.safeParse(payload.new);
          if (!parsed.success) return;
          setState((current) => ({ ...current, lastEvent: parsed.data }));
          callback.current(parsed.data);
        })
      .subscribe(async (status) => {
        if (stopped) return;
        const connected = status === "SUBSCRIBED";
        setState((current) => ({ ...current, connected }));
        if (connected) { try { await channel.track({ participantId, onlineAt: new Date().toISOString() } satisfies RoomPresence); } catch { /* HTTP polling remains authoritative. */ } }
      });
    return () => {
      stopped = true;
      void client.removeChannel(channel).catch(() => undefined);
    };
  }, [roomId, participantId]);
  return state;
}
