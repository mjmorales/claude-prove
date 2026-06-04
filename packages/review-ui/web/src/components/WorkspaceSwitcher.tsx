import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";
import { useActiveProject, type ProjectInfo } from "../lib/active-project";
import { cn } from "../lib/cn";

/**
 * Header control for switching the active workspace. Lists every registered
 * project from `GET /api/projects`, highlights the active one, and on selection
 * calls `setProjectKey(info.path)` — the DECODED registry path the fetch funnel
 * re-encodes exactly once. NEVER passes `info.id` (the encoded form): that would
 * double-encode the `?project=` wire param.
 *
 * The behind-schema state of each project is surfaced subtly inline so the
 * operator sees which workspaces are read-only before switching into them.
 */
export function WorkspaceSwitcher() {
  const { projectKey, setProjectKey, project } = useActiveProject();
  const [open, setOpen] = useState(false);
  const { data, isLoading } = useQuery({
    queryKey: ["projects"],
    queryFn: api.projects,
  });
  const projects = data?.projects ?? [];

  // The trigger label tracks the resolved record when known, falling back to
  // the raw key (a shared `?project=` link can pin a key before the list
  // resolves) and finally to the startup-root default.
  const triggerLabel = project?.name ?? projectKey ?? "Startup root";

  const select = (info: ProjectInfo) => {
    setProjectKey(info.path);
    setOpen(false);
  };

  return (
    <div className="relative">
      <button
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label="Switch workspace"
        onClick={() => setOpen((x) => !x)}
        title="Switch workspace"
        className="flex items-center gap-2 px-3 h-8 rounded-md border border-bg-line bg-bg-panel hover:bg-bg-raised transition-colors max-w-[260px]"
      >
        <span className="text-fg-faint text-[12px]">◫</span>
        <span className="mono text-[12.5px] text-fg-bright truncate">{triggerLabel}</span>
        {project?.store.behind === true && <BehindDot />}
        <span className="text-fg-faint text-[10px]">▾</span>
      </button>

      {open && (
        <>
          {/* Click-away scrim closes the menu without trapping focus. */}
          <button
            type="button"
            aria-label="Close workspace menu"
            className="fixed inset-0 z-30 cursor-default"
            onClick={() => setOpen(false)}
          />
          <ul
            role="listbox"
            aria-label="Workspaces"
            className="absolute left-0 top-full mt-1 z-40 min-w-[280px] max-w-[420px] max-h-[60vh] overflow-auto rounded-md border border-bg-line bg-bg-deep shadow-soft py-1"
          >
            {isLoading && (
              <li className="px-3 py-2 text-[12px] text-fg-faint">Loading workspaces…</li>
            )}
            {!isLoading && projects.length === 0 && (
              <li className="px-3 py-2 text-[12px] text-fg-faint">No registered workspaces</li>
            )}
            {projects.map((info) => (
              <ProjectRow
                key={info.id}
                info={info}
                active={info.path === projectKey}
                onSelect={() => select(info)}
              />
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

function ProjectRow({
  info,
  active,
  onSelect,
}: {
  info: ProjectInfo;
  active: boolean;
  onSelect: () => void;
}) {
  return (
    <li>
      <button
        type="button"
        role="option"
        aria-selected={active}
        onClick={onSelect}
        className={cn(
          "w-full flex items-center gap-2 px-3 py-1.5 text-left transition-colors",
          active ? "bg-phos/15 text-fg-bright" : "text-fg-base hover:bg-bg-raised",
        )}
      >
        <span className="w-2 flex-shrink-0">
          {active && <span className="text-phos text-[12px]">●</span>}
        </span>
        <span className="flex flex-col min-w-0">
          <span className="flex items-center gap-1.5">
            <span className="text-[13px] font-medium truncate">{info.name}</span>
            {info.store.behind === true && <BehindDot />}
          </span>
          <span className="mono text-[11px] text-fg-faint truncate">{info.path}</span>
        </span>
      </button>
    </li>
  );
}

/** Small amber dot marking a project whose store sits behind the server's
 * expected schema — a subtle read-only cue in the list and trigger. */
function BehindDot() {
  return (
    <span
      title="Store schema is behind — read-only"
      className="inline-block w-1.5 h-1.5 rounded-full bg-amber flex-shrink-0"
    />
  );
}
