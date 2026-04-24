import { useEffect } from "react";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { subscribeSse, type SseChangeEvent } from "./sseBus";

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

export function useEventStream() {
  const qc = useQueryClient();
  useEffect(() => {
    const unsubscribe = subscribeSse({
      onChange: (evt: SseChangeEvent) => {
        invalidate(qc, keysForPath(evt.path));
      },
    });
    return unsubscribe;
  }, [qc]);
}
