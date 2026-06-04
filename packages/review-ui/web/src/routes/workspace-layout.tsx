import { Outlet } from "react-router-dom";
import { BehindSchemaBanner } from "../components/BehindSchemaBanner";

/**
 * Active-workspace-scoped layout. Everything below the global header that is
 * keyed to the active project mounts here: the behind-schema banner (driven by
 * the active project's store state) sits above the <Outlet /> where the /acb
 * and /scrum feature subtrees render. Scoping the banner here — rather than the
 * global header — keeps it adjacent to the project-scoped surface it qualifies.
 */
export function WorkspaceLayout() {
  return (
    <div className="h-full min-h-0 flex flex-col">
      <BehindSchemaBanner />
      <div className="flex-1 min-h-0">
        <Outlet />
      </div>
    </div>
  );
}
