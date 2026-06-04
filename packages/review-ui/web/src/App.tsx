import { useEffect, useState } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { StatusHeader } from "./components/StatusHeader";
import { StatusBar } from "./components/StatusBar";
import { CommandPalette } from "./components/CommandPalette";
import { useEventStream } from "./hooks/useEvents";
import { useHotkeys } from "./hooks/useHotkeys";
import { useSidebarSize } from "./hooks/useSidebarSize";
import { AcbRoute } from "./routes/acb";
import { ScrumRoute } from "./routes/scrum";
import { WorkspaceLayout } from "./routes/workspace-layout";
import { api } from "./lib/api";
import {
  ActiveProjectProvider,
  useActiveProject,
  type ProjectInfo,
} from "./lib/active-project";

/**
 * Root mount. Owns the resolved `ProjectInfo` record so it can feed it into the
 * `ActiveProjectProvider`'s `project` seam: the provider owns the active key,
 * `ResolveActiveRecord` (a provider child) reads that key + the fetched project
 * list and lifts the matching record up here via state, and this component
 * passes it back down as the provider's `project` prop. That round-trip keeps
 * the provider free of any data fetching while making `useActiveProject().project`
 * live everywhere the key resolves to a known registry entry.
 */
export function App() {
  const [record, setRecord] = useState<ProjectInfo | null>(null);
  return (
    <ActiveProjectProvider project={record}>
      <ResolveActiveRecord onResolve={setRecord} />
      <Shell />
    </ActiveProjectProvider>
  );
}

/**
 * Bridge that resolves the active project's record. Reads the active key from
 * the provider, fetches the project list once (TanStack-cached), matches on the
 * DECODED path, and reports the result up so the provider can re-supply it. A
 * null key (startup-root default) resolves to null — no banner, no behind-schema
 * gating. Renders nothing; it exists solely for the resolve effect.
 */
function ResolveActiveRecord({
  onResolve,
}: {
  onResolve: (record: ProjectInfo | null) => void;
}) {
  const { projectKey } = useActiveProject();
  const { data } = useQuery({ queryKey: ["projects"], queryFn: api.projects });
  const projects = data?.projects;

  useEffect(() => {
    if (projectKey === null) {
      onResolve(null);
      return;
    }
    const match = projects?.find((p) => p.path === projectKey) ?? null;
    onResolve(match);
  }, [projectKey, projects, onResolve]);

  return null;
}

/**
 * App shell. Hosts persistent chrome (StatusHeader + StatusBar + CommandPalette)
 * plus global hotkeys/SSE, then delegates the project-scoped surface to the
 * workspace layout and its route children.
 *
 * Routes:
 *   /         -> redirect to /acb
 *   /*        -> WorkspaceLayout (behind-schema banner + Outlet) wrapping:
 *                  /acb/*    -> ACB review experience
 *                  /scrum/*  -> Scrum operator dashboard
 */
function Shell() {
  useEventStream();
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [paletteQuery, setPaletteQuery] = useState("");
  const openPalette = (q?: string) => {
    setPaletteQuery(q ?? "");
    setPaletteOpen(true);
  };
  useHotkeys({ onOpenPalette: () => openPalette() });

  const { toggleCollapsed } = useSidebarSize();
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key === ".") {
        e.preventDefault();
        toggleCollapsed();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [toggleCollapsed]);

  return (
    <div className="h-full flex flex-col min-h-0">
      <StatusHeader onOpenPalette={openPalette} />
      <div className="flex-1 min-h-0">
        <Routes>
          <Route path="/" element={<Navigate to="/acb" replace />} />
          <Route element={<WorkspaceLayout />}>
            <Route path="/acb/*" element={<AcbRoute />} />
            <Route path="/scrum/*" element={<ScrumRoute />} />
          </Route>
        </Routes>
      </div>
      <StatusBar />
      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        initialQuery={paletteQuery}
      />
    </div>
  );
}
