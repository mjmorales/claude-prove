import { useEffect } from "react";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import {
  canonicalProjectId,
  setActiveProjectKey,
  subscribeSse,
  type SseChangeEvent,
} from "./sseBus";
import { useActiveProject } from "../lib/active-project";

// Topical groups of react-query keys. The SSE payload's path prefix selects
// which groups to invalidate -- invalidating all 15 keys on every heartbeat
// caused visible refetch churn.
const GIT_KEYS = [
  "runs",
  "run",
  "branches",
  "status",
  "diff",
  "diff-file",
  "pending",
  "pending-file",
  "commits",
] as const;

const RUN_STATE_KEYS = [
  "runs",
  "run",
  "manifest",
  "status",
  "pending",
  "pending-file",
  "steps",
  "progress",
  "commits",
  "intents",
  "review",
] as const;

const DOCS_KEYS = ["decisions", "doc"] as const;

// Union of every key we might invalidate -- used as the fallback when the
// payload doesn't match any known prefix.
const ALL_KEYS: readonly string[] = Array.from(
  new Set<string>([...GIT_KEYS, ...RUN_STATE_KEYS, ...DOCS_KEYS]),
);

function invalidate(qc: QueryClient, keys: readonly string[]): void {
  for (const key of keys) qc.invalidateQueries({ queryKey: [key] });
}

/**
 * Resolve which query groups a file-change path affects.
 *
 * Server emits paths relative to repo root:
 *   - `.git/refs/...`, `.git/HEAD`, `.git/worktrees/...` -> git-affecting
 *   - `.prove/runs/<slug>/decisions|docs/...`          -> docs-only
 *   - `.prove/runs/<slug>/...`                         -> run-state
 */
function keysForPath(relPath: string): readonly string[] {
  if (relPath.startsWith(".git/") || relPath === ".git/HEAD") {
    return GIT_KEYS;
  }
  if (relPath.startsWith(".prove/runs/")) {
    // Strip `.prove/runs/<slug>/` to inspect the subtree.
    const rest = relPath.split("/").slice(3).join("/");
    if (rest.startsWith("decisions/") || rest.startsWith("docs/")) {
      return DOCS_KEYS;
    }
    return RUN_STATE_KEYS;
  }
  // Unrecognized path -- keep behavior safe by invalidating everything.
  return ALL_KEYS;
}

/**
 * Decide whether an SSE change event belongs to the active project.
 *
 * Acceptance policy for the null active key: the bus is connected to the
 * unparameterized `/api/events` stream (the server's startup-root default),
 * which the client has no project id for. Rather than guess that root's
 * encoded id, the client accepts every event from that stream — the connection
 * itself is the demux. Because the bus reconnects on a key change and the
 * server scopes each stream to one project, no other project's events can
 * arrive on the null-key stream, so blanket acceptance is correct, not lossy.
 *
 * With a non-null active key, only events whose `project` matches it are
 * accepted; everything else (a late event from a stream being torn down) is
 * dropped without invalidating, so a project switch never refetches the wrong
 * project's caches. The active key and the event's `project` field can be in
 * different encodings (decoded path vs the server's `encodeURIComponent` id),
 * so both are canonicalized before comparison.
 */
function eventMatchesActiveProject(
  evt: SseChangeEvent,
  activeKey: string | null,
): boolean {
  if (activeKey === null) return true;
  if (evt.project === undefined) return false;
  return canonicalProjectId(evt.project) === canonicalProjectId(activeKey);
}

/**
 * Subscribe the active project's file-change stream to react-query
 * invalidation. Reconnects the shared SSE bus whenever the active project key
 * changes, then narrows each accepted event to the affected query groups.
 *
 * Query keys are not yet project-scoped (callers key off `slug` alone). Until
 * the shell threads the active key into every query key, cross-project
 * invalidation is prevented at this layer: the bus only carries one project's
 * stream at a time and `eventMatchesActiveProject` drops anything else, so the
 * existing flat groups are only invalidated for the active project's events.
 */
export function useEventStream() {
  const qc = useQueryClient();
  const { projectKey } = useActiveProject();
  useEffect(() => {
    // Reconnect the bus to the active project's stream before subscribing, so
    // the first events this subscriber sees already come from the right stream.
    setActiveProjectKey(projectKey);
    const unsubscribe = subscribeSse({
      onChange: (evt: SseChangeEvent) => {
        if (!eventMatchesActiveProject(evt, projectKey)) return;
        invalidate(qc, keysForPath(evt.path));
      },
    });
    return unsubscribe;
  }, [qc, projectKey]);
}
