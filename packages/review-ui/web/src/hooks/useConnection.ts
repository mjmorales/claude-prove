import { useEffect, useState } from "react";

export type ConnState = "connecting" | "live" | "stale" | "down";

export function useConnection() {
  const [state, setState] = useState<ConnState>("connecting");
  const [lastEvent, setLastEvent] = useState<number>(Date.now());

  useEffect(() => {
    const es = new EventSource("/api/events");
    es.onopen = () => setState("live");
    es.onerror = () => setState("down");
    es.addEventListener("change", () => {
      setState("live");
      setLastEvent(Date.now());
    });
    // heartbeat comments reset state to live
    es.onmessage = () => setState("live");
    const stale = setInterval(() => {
      setState((s) => (s === "live" && Date.now() - lastEvent > 60_000 ? "stale" : s));
    }, 10_000);
    return () => {
      es.close();
      clearInterval(stale);
    };
  }, [lastEvent]);

  return { state, lastEvent };
}
