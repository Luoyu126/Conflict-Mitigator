"use client";

import { useEffect, useRef, useState } from "react";

type SpeechRecognitionResultItem = { isFinal: boolean; 0: { transcript: string } };
type SpeechRecognitionResultList = { length: number; [index: number]: SpeechRecognitionResultItem };
type SpeechRecognitionEvent = { resultIndex: number; results: SpeechRecognitionResultList };
type SpeechRecognitionErrorEvent = { error: string };
type SpeechRecognitionLike = {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((event: SpeechRecognitionEvent) => void) | null;
  onerror: ((event: SpeechRecognitionErrorEvent) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
};
type SpeechRecognitionConstructor = new () => SpeechRecognitionLike;

function speechRecognitionConstructor(): SpeechRecognitionConstructor | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as {
    SpeechRecognition?: SpeechRecognitionConstructor;
    webkitSpeechRecognition?: SpeechRecognitionConstructor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export type SpeechRecognitionStatus = "idle" | "listening" | "unsupported" | "error";

export type UseSpeechRecognitionOptions = {
  /** True only while the participant has transcription consent and is in the meeting. */
  enabled: boolean;
  /** Invoked once per browser-confirmed final utterance (trimmed, non-empty). */
  onFinal: (text: string) => void;
};

/**
 * Browser Web Speech recognition emitting only final results. Interim results are
 * never surfaced. Unsupported browsers and empty results are ignored, never replaced
 * with preset or manually typed transcript content.
 */
export function useSpeechRecognition({ enabled, onFinal }: UseSpeechRecognitionOptions) {
  const supported = typeof window !== "undefined" && speechRecognitionConstructor() !== null;
  const [error, setError] = useState(false);
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const onFinalRef = useRef(onFinal);

  useEffect(() => {
    onFinalRef.current = onFinal;
  }, [onFinal]);

  useEffect(() => {
    if (!enabled) return;
    const Constructor = speechRecognitionConstructor();
    if (!Constructor) return;
    const recognition = new Constructor();
    let stopped = false;
    recognition.continuous = true;
    recognition.interimResults = false;
    recognition.lang = typeof navigator !== "undefined" ? navigator.language : "en-US";
    recognition.onresult = (event) => {
      for (let index = event.resultIndex; index < event.results.length; index += 1) {
        const item = event.results[index];
        if (!item?.isFinal) continue;
        const text = item[0]?.transcript?.trim();
        if (text) onFinalRef.current(text);
      }
    };
    recognition.onerror = () => {
      stopped = true;
      setError(true);
    };
    recognition.onend = () => {
      if (enabled && !stopped && recognitionRef.current === recognition) {
        try { recognition.start(); } catch { /* already listening */ }
      }
    };
    recognitionRef.current = recognition;
    try {
      recognition.start();
    } catch {
      stopped = true;
      queueMicrotask(() => setError(true));
    }
    return () => {
      stopped = true;
      recognitionRef.current = null;
      try { recognition.abort(); } catch { /* ignore */ }
      setError(false);
    };
  }, [enabled]);

  const status: SpeechRecognitionStatus = !supported
    ? "unsupported"
    : !enabled
      ? "idle"
      : error
        ? "error"
        : "listening";

  return { status };
}
