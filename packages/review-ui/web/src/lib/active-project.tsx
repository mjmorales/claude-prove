import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { setActiveProjectKeyForRequests } from "./fetch-utils";

/**
 * One project row from `GET /api/projects`. The `id` is the URL-safe
 * `?project=` key (`encodeURIComponent(path)`); `store` mirrors the server's
 * schema-state badge for the project's `.prove/prove.db`. Co-located here so
 * downstream consumers of the active-project context import one shape.
 */
export interface ProjectInfo {
  /** URL-safe `?project=` key — `encodeURIComponent(path)`. */
  id: string;
  /** Absolute repository root. */
  path: string;
  /** Display basename. */
  name: string;
  /** ISO-8601 of the most recent registry upsert, or null if absent. */
  last_seen: string | null;
  /** Schema-state of the project's store: which version it sits at and
   * whether that is behind what the server expects. */
  store: {
    schema_version: number | null;
    behind: boolean | null;
  };
}

/**
 * The active-project context value. `projectKey` is the single source of truth
 * for which project data routes target (null = the server's startup-root
 * default). `project` is the selected project record once a fetcher resolves
 * it, or null until known — this provider owns the key but does NOT fetch
 * `/api/projects`; the shell injects the record via the provider's optional
 * `project` prop.
 */
export interface ActiveProjectValue {
  /**
   * The DECODED registry path (e.g. `/home/me/repo`), never the encoded
   * `?project=` id. The fetch funnel re-encodes it exactly once on the way out,
   * so storing the encoded form here would double-encode the wire param. Feed
   * `ProjectInfo.path` directly; NEVER feed `ProjectInfo.id` (the encoded
   * `encodeURIComponent(path)` form) — convert it with `projectIdToPath` first.
   */
  projectKey: string | null;
  /**
   * Set the active project. The argument is the DECODED registry path, matching
   * `projectKey`. NEVER pass `ProjectInfo.id` or an SSE `event.project` (both
   * carry the encoded form) — route those through `projectIdToPath` first, or
   * pass `ProjectInfo.path` directly.
   */
  setProjectKey: (key: string | null) => void;
  project: ProjectInfo | null;
}

/**
 * THE chokepoint for the decoded-path ↔ encoded-id conversion. `projectKey`
 * (and `ProjectInfo.path`) hold the DECODED registry path; `ProjectInfo.id` and
 * the SSE payload's `project` field hold the ENCODED `encodeURIComponent(path)`
 * form the `?project=` wire param uses. Route every cross between the two forms
 * through this pair so the encode/decode boundary lives in exactly one place.
 */
export function pathToProjectId(path: string): string {
  return encodeURIComponent(path);
}

/**
 * Inverse of `pathToProjectId`: turn an encoded project id (a `ProjectInfo.id`
 * or an SSE `event.project`) back into the decoded registry path that
 * `setProjectKey`/`projectKey` expect. Pair these for switcher wiring
 * (`setProjectKey(projectIdToPath(info.id))`) and SSE demux
 * (`event.project === pathToProjectId(projectKey)`).
 */
export function projectIdToPath(id: string): string {
  return decodeURIComponent(id);
}

const STORAGE_KEY = "prove-review.active-project.v1";

const ActiveProjectContext = createContext<ActiveProjectValue | null>(null);

/**
 * Resolve the initial project key with a fixed precedence: the URL
 * `?project=` search param wins (so shared links pin a project), then the
 * persisted localStorage value, else null (the startup-root default). Reads
 * `window.location.search` directly rather than a router hook so the seed is
 * available before any Route mounts.
 */
function seedProjectKey(): string | null {
  const fromUrl = new URLSearchParams(window.location.search).get("project");
  if (fromUrl) return fromUrl;
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

/** Persist the active key, or clear it on null. Swallows storage errors
 * (private-mode / quota) the same way the layout-size hooks do. */
function persistProjectKey(key: string | null): void {
  try {
    if (key) localStorage.setItem(STORAGE_KEY, key);
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* noop */
  }
}

/**
 * Owns and broadcasts the active project key. Mount above the router so every
 * route shares one key. The `project` prop is the externally-supplied record
 * seam: the shell fetches `/api/projects`, resolves the record for the current
 * key, and passes it down — keeping this provider free of any data fetching.
 */
export function ActiveProjectProvider({
  children,
  project = null,
}: {
  children: ReactNode;
  project?: ProjectInfo | null;
}) {
  const [projectKey, setProjectKeyState] = useState<string | null>(seedProjectKey);

  const setProjectKey = useCallback((key: string | null) => {
    persistProjectKey(key);
    setProjectKeyState(key);
  }, []);

  // Broadcast the active key to the fetch layer, which injects it as the
  // `?project=` param on every data request. This effect is the sole writer of
  // that module-level value, keeping project-key injection single-sourced in
  // fetch-utils rather than threaded per-route.
  useEffect(() => {
    setActiveProjectKeyForRequests(projectKey);
  }, [projectKey]);

  const value = useMemo<ActiveProjectValue>(
    () => ({ projectKey, setProjectKey, project }),
    [projectKey, setProjectKey, project],
  );

  return (
    <ActiveProjectContext.Provider value={value}>{children}</ActiveProjectContext.Provider>
  );
}

/** Consume the active-project context. Throws when used outside the provider
 * so a missing mount is a loud failure rather than a silent null key. */
export function useActiveProject(): ActiveProjectValue {
  const ctx = useContext(ActiveProjectContext);
  if (!ctx) {
    throw new Error("useActiveProject must be used within an ActiveProjectProvider");
  }
  return ctx;
}
