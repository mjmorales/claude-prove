import { useEffect, useRef, useState } from "react";
import { subscribeSse, type SseStatus } from "./sseBus";

export type ConnState = "connecting" | "live" | "stale" | "down";

const STALE_AFTER_MS = 60_000;
const STALE_POLL_MS = 10_000;

/**
 * Tracks SSE liveness for UI badges (Live / Stale / Offline / Idle).
 *
 * Implementation notes:
 * - Subscribes to the shared `sseBus` so only one EventSource exists per tab.
 * - Activity timestamps live in a ref, so the 10 s staleness poll can read
 *   fresh values without re-running the subscription effect. An earlier
 *   version kept the timestamp in state and listed it in the effect deps,
 *   which tore down and recreated the EventSource on every heartbeat.
 * - `lastEvent` is also surfaced as state for consumers that display it,
 *   but it's only bumped on real `change` payloads, not heartbeats.
 */
export function useConnection() {
  const [state, setState] = useState<ConnState>("connecting");
  const [lastEvent, setLastEvent] = useState<number>(() => Date.now());
  const lastActivityRef = useRef<number>(Date.now());

  useEffect(() => {
    const mapStatus = (s: SseStatus): ConnState =>
      s === "live" ? "live" : s === "down" ? "down" : "connecting";

    const unsubscribe = subscribeSse({
      onStatus: (s) => setState(mapStatus(s)),
      onActivity: () => {
        lastActivityRef.current = Date.now();
      },
      onChange: () => {
        setLastEvent(Date.now());
      },
    });

    const stalePoll = setInterval(() => {
      setState((prev) =>
        prev === "live" && Date.now() - lastActivityRef.current > STALE_AFTER_MS
          ? "stale"
          : prev,
      );
    }, STALE_POLL_MS);

    return () => {
      unsubscribe();
      clearInterval(stalePoll);
    };
  }, []);

  return { state, lastEvent };
}
