"use client";
import { useEffect, useRef, useState } from "react";

type Recognition = {
  continuous: boolean; interimResults: boolean; lang: string;
  onresult: ((event: { resultIndex: number; results: { length: number; [index: number]: { isFinal: boolean; 0: { transcript: string } } } }) => void) | null;
  onerror: ((event: { error: string }) => void) | null; onend: (() => void) | null;
  start(track: MediaStreamTrack): void; abort(): void;
};
type RecognitionConstructor = new () => Recognition;
function getConstructor() {
  if (typeof window === "undefined") return null;
  const browser = window as unknown as { SpeechRecognition?: RecognitionConstructor; webkitSpeechRecognition?: RecognitionConstructor };
  return browser.SpeechRecognition ?? browser.webkitSpeechRecognition ?? null;
}
export function useSpeechRecognition({ enabled, audioTrack, onFinal }: {
  enabled: boolean; audioTrack: MediaStreamTrack | undefined; onFinal: (text: string) => void;
}) {
  const [status, setStatus] = useState<"idle" | "listening" | "unsupported" | "error">("idle");
  const callback = useRef(onFinal);
  useEffect(() => { callback.current = onFinal; }, [onFinal]);
  useEffect(() => {
    const Constructor = getConstructor();
    let stopped = false;
    const update = (next: typeof status) => { if (!stopped) setStatus(next); };
    if (!enabled || !audioTrack || audioTrack.readyState !== "live") {
      queueMicrotask(() => update(Constructor ? "idle" : "unsupported"));
      return () => { stopped = true; };
    }
    if (!Constructor) { queueMicrotask(() => update("unsupported")); return () => { stopped = true; }; }
    const recognition = new Constructor();
    recognition.continuous = true; recognition.interimResults = false; recognition.lang = navigator.language || "en-US";
    let timer: ReturnType<typeof setTimeout>;
    function start() {
      if (stopped || audioTrack?.readyState !== "live") return;
      try { recognition.start(audioTrack); update("listening"); }
      catch { update("error"); stopped = true; }
    }
    recognition.onresult = event => {
      if (stopped || audioTrack.readyState !== "live" || !audioTrack.enabled) return;
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i]; const text = result?.[0]?.transcript?.trim();
        if (result?.isFinal && text) callback.current(text);
      }
    };
    recognition.onerror = () => { update("error"); stopped = true; recognition.abort(); };
    recognition.onend = () => { if (!stopped) timer = setTimeout(start, 250); };
    function ended() { update("idle"); stopped = true; recognition.abort(); }
    audioTrack.addEventListener("ended", ended);
    timer = setTimeout(start, 0);
    return () => {
      stopped = true; clearTimeout(timer); audioTrack.removeEventListener("ended", ended);
      recognition.onresult = null; recognition.onend = null; recognition.onerror = null;
      try { recognition.abort(); } catch { /* Already stopped. */ }
    };
  }, [enabled, audioTrack]);
  return { status: enabled ? status : "idle" as const };
}
