// Shared SSE subscription bus for the review UI.
//
// Problem: two hooks (`useConnection`, `useEventStream`) each opened their own
// `EventSource('/api/events')`, so every tab maintained two live SSE streams.
// Solution: reference-counted singleton -- the first subscriber opens the
// connection, subsequent subscribers attach to the same EventSource, and the
// connection closes when the last subscriber detaches.
//
// Per-project routing: the bus connects to exactly one project's stream at a
// time, selected by `activeProjectKey`. When the active key changes the bus
// tears the old EventSource down cleanly and reopens against the new stream, so
// no stale connection survives a project switch. The server stamps every
// `event: change` payload with the resolved `project` id; subscribers demux off
// that field. Heartbeats are project-less SSE comments and signal liveness only.
//
// Pattern: Observer + reference counting (see useConnection.ts for staleness
// logic that reads this bus's events).

import { pathToProjectId } from "../lib/active-project";

export type SseStatus = "connecting" | "live" | "down";

export interface SseChangeEvent {
  kind: string;
  path: string;
  // The resolved project id the server stamps on every data event: the
  // URL-encoded registered root. Absent on the unparameterized stream (the
  // server's startup-root default), which the client connects to when no
  // project key is active.
  project?: string;
}

export interface SseSubscriber {
  onChange?: (evt: SseChangeEvent) => void;
  onStatus?: (status: SseStatus) => void;
  // Fired on any message (including heartbeat comments) so the connection
  // hook can refresh its last-seen-activity timestamp.
  onActivity?: () => void;
}

// The project key the bus is currently connected against. null = the
// unparameterized `/api/events` stream (server startup-root default); a
// non-null value routes to `/api/events?project=<key>`. Mutated only through
// `setActiveProjectKey`, which reconnects when the value actually changes.
let activeProjectKey: string | null = null;

let source: EventSource | null = null;
let status: SseStatus = "connecting";
const subscribers = new Set<SseSubscriber>();

/** Build the stream URL for the active key: bare when null, parameterized
 * otherwise. The key is the DECODED registry path; `pathToProjectId` encodes it
 * exactly once into the server's `?project=` form. A single encode never throws
 * (unlike a decode-then-encode, which a literal-`%` path like `/repos/100%done`
 * would crash with `URIError`) and round-trips byte-for-byte with the encoded
 * `project` field the server stamps on every event. */
function streamUrl(key: string | null): string {
  return key === null ? "/api/events" : `/api/events?project=${pathToProjectId(key)}`;
}

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
  const es = new EventSource(streamUrl(activeProjectKey));
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

/**
 * Point the bus at a different project's stream. A no-op when the key is
 * unchanged. With live subscribers it reconnects in place: the old EventSource
 * is closed and a fresh one opened against the new key, so events from the old
 * project's stream cannot leak past the switch. With no subscribers it only
 * records the key; the next `subscribeSse` opens against it.
 */
export function setActiveProjectKey(key: string | null): void {
  if (key === activeProjectKey) return;
  activeProjectKey = key;
  if (subscribers.size === 0) return;
  closeSource();
  openSource();
  // Seed every subscriber with the reconnecting status so badges reflect the
  // teardown immediately rather than lingering on the prior project's "live".
  for (const sub of subscribers) sub.onStatus?.(status);
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
