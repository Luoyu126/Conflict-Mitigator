"use client";
import { useEffect, useRef } from "react";

/** One in-flight read; abort and discard work when the route/refresh generation changes. */
export function useApiPoll(task: (signal: AbortSignal) => Promise<void>, key: string | number, interval = 1000) {
  const current = useRef(task);
  useEffect(() => { current.current = task; }, [task]);
  useEffect(() => {
    const controller = new AbortController(); let timer: ReturnType<typeof setTimeout>;
    async function run() {
      try { await current.current(AbortSignal.any([controller.signal, AbortSignal.timeout(5000)])); }
      catch { /* The task owns its user-facing error state. */ }
      finally { if (!controller.signal.aborted) timer = setTimeout(run, interval); }
    }
    void run();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [key, interval]);
}
