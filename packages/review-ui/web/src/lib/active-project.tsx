import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";

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
  projectKey: string | null;
  setProjectKey: (key: string | null) => void;
  project: ProjectInfo | null;
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
