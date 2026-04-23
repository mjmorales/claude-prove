import { NavLink, Outlet } from "react-router-dom";
import { useScrumUrlState } from "../../hooks/useScrumUrlState";
import { cn } from "../../lib/cn";

/**
 * Scrum dashboard layout. Thin nav bar of the five views + <Outlet /> for
 * the active child route. Sits inside the App shell (StatusHeader above,
 * StatusBar below), so chrome is not duplicated here.
 *
 * The single route-wide side effect is `useScrumUrlState()` — it scopes the
 * `?task=<id>` sync to the scrum surface so the ACB URL state machine stays
 * independent.
 */
const NAV: Array<{ to: string; label: string }> = [
  { to: "/scrum/now", label: "Now" },
  { to: "/scrum/board", label: "Board" },
  { to: "/scrum/milestones", label: "Milestones" },
  { to: "/scrum/alerts", label: "Alerts" },
];

export function ScrumLayout() {
  useScrumUrlState();
  return (
    <div className="h-full min-h-0 flex flex-col bg-bg-void text-fg-base">
      <nav
        aria-label="Scrum views"
        className="shrink-0 h-10 px-4 flex items-center gap-1 border-b border-bg-line bg-bg-deep"
      >
        <span className="eyebrow mr-3">Scrum</span>
        {NAV.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end
            className={({ isActive }) =>
              cn(
                "px-3 h-7 flex items-center rounded-md text-[12.5px] mono transition-colors",
                isActive
                  ? "bg-phos/15 text-phos border border-phos/40"
                  : "text-fg-dim hover:text-fg-bright hover:bg-bg-raised",
              )
            }
          >
            {item.label}
          </NavLink>
        ))}
      </nav>
      <div className="flex-1 min-h-0 overflow-auto">
        <Outlet />
      </div>
    </div>
  );
}
