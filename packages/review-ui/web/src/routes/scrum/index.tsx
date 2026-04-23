import { Navigate, Route, Routes } from "react-router-dom";
import { ScrumLayout } from "./layout";
import { ScrumNowView } from "./now";
import { ScrumBoardView } from "./board";
import { ScrumMilestonesView } from "./milestones";
import { ScrumAlertsView } from "./alerts";
import { ScrumTaskDetailView } from "./task/[id]";

/**
 * Scrum dashboard route tree. Mounted under `/scrum/*` from App.tsx.
 *
 *   /scrum            -> redirect to /scrum/now
 *   /scrum/now        -> Now view
 *   /scrum/board      -> Board view
 *   /scrum/task/:id   -> Task detail
 *   /scrum/milestones -> Milestones view
 *   /scrum/alerts     -> Alerts view
 *
 * The layout owns the top tabbar + `useScrumUrlState` sync; all children
 * render inside its <Outlet />. Read-only by design: no POST/PUT/DELETE
 * fetches occur in this subtree.
 */
export function ScrumRoute() {
  return (
    <Routes>
      <Route element={<ScrumLayout />}>
        <Route index element={<Navigate to="/scrum/now" replace />} />
        <Route path="now" element={<ScrumNowView />} />
        <Route path="board" element={<ScrumBoardView />} />
        <Route path="task/:id" element={<ScrumTaskDetailView />} />
        <Route path="milestones" element={<ScrumMilestonesView />} />
        <Route path="alerts" element={<ScrumAlertsView />} />
        <Route path="*" element={<Navigate to="/scrum/now" replace />} />
      </Route>
    </Routes>
  );
}
