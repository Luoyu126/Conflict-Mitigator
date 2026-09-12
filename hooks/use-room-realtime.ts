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
    const client = getBrowserSupabase();
    const channel = client.channel(`room:${roomId}`, { config: { presence: { key: participantId } } });
    const syncPresence = () => {
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
          const parsed = roomEventSchema.safeParse(payload.new);
          if (!parsed.success) return;
          setState((current) => ({ ...current, lastEvent: parsed.data }));
          callback.current(parsed.data);
        })
      .subscribe(async (status) => {
        const connected = status === "SUBSCRIBED";
        setState((current) => ({ ...current, connected }));
        if (connected) await channel.track({ participantId, onlineAt: new Date().toISOString() } satisfies RoomPresence);
      });
    return () => {
      void channel.untrack().finally(() => client.removeChannel(channel));
      setState({ connected: false, onlineParticipantIds: [], lastEvent: null });
    };
  }, [roomId, participantId]);
  return state;
}
