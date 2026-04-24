// Shared SSE subscription bus for the review UI.
//
// Problem: two hooks (`useConnection`, `useEventStream`) each opened their own
// `EventSource('/api/events')`, so every tab maintained two live SSE streams.
// Solution: reference-counted singleton -- the first subscriber opens the
// connection, subsequent subscribers attach to the same EventSource, and the
// connection closes when the last subscriber detaches.
//
// Pattern: Observer + reference counting (see useConnection.ts for staleness
// logic that reads this bus's events).

export type SseStatus = "connecting" | "live" | "down";

export interface SseChangeEvent {
  kind: string;
  path: string;
}

export interface SseSubscriber {
  onChange?: (evt: SseChangeEvent) => void;
  onStatus?: (status: SseStatus) => void;
  // Fired on any message (including heartbeat comments) so the connection
  // hook can refresh its last-seen-activity timestamp.
  onActivity?: () => void;
}

let source: EventSource | null = null;
let status: SseStatus = "connecting";
const subscribers = new Set<SseSubscriber>();

function broadcastStatus(next: SseStatus): void {
  status = next;
  for (const sub of subscribers) sub.onStatus?.(next);
}

function broadcastChange(evt: SseChangeEvent): void {
  for (const sub of subscribers) {
    sub.onChange?.(evt);
    sub.onActivity?.();
  }
}

function broadcastActivity(): void {
  for (const sub of subscribers) sub.onActivity?.();
}

function openSource(): void {
  if (source) return;
  const es = new EventSource("/api/events");
  source = es;
  status = "connecting";

  es.onopen = () => broadcastStatus("live");
  es.onerror = () => broadcastStatus("down");
  // Heartbeat comments arrive as default `message` events and signal liveness.
  es.onmessage = () => {
    broadcastStatus("live");
    broadcastActivity();
  };
  es.addEventListener("change", (evt: MessageEvent) => {
    let payload: SseChangeEvent;
    try {
      payload = JSON.parse(evt.data) as SseChangeEvent;
    } catch {
      // Malformed payloads still count as liveness signals.
      broadcastStatus("live");
      broadcastActivity();
      return;
    }
    broadcastStatus("live");
    broadcastChange(payload);
  });
}

function closeSource(): void {
  if (!source) return;
  source.close();
  source = null;
  status = "connecting";
}

export function subscribeSse(sub: SseSubscriber): () => void {
  subscribers.add(sub);
  if (subscribers.size === 1) openSource();
  // Seed the new subscriber with the current status so it renders consistently.
  sub.onStatus?.(status);
  return () => {
    subscribers.delete(sub);
    if (subscribers.size === 0) closeSource();
  };
}
