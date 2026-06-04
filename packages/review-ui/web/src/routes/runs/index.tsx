import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { Shell } from "../../components/Shell";
import { Sidebar, type SidebarSection } from "../../components/Sidebar";
import { Empty } from "../../components/Empty";
import { api } from "../../lib/api";
import { useActiveProject } from "../../lib/active-project";
import { RunsListPanel } from "./RunsListPanel";
import { RunDocsPanel } from "./RunDocsPanel";
import { BriefPanel } from "./BriefPanel";
import { RunDecisionsPanel } from "./RunDecisionsPanel";
import { useRunsSelection, type RunDetailTab } from "./store";
import { cn } from "../../lib/cn";

const TABS: Array<{ id: RunDetailTab; label: string }> = [
  { id: "docs", label: "Docs" },
  { id: "brief", label: "Brief" },
  { id: "decisions", label: "Decisions" },
];

/**
 * Project-scoped Runs surface. The sidebar lists the active project's runs; the
 * inspector tabs the selected run across docs / reasoning brief / decisions.
 * Mounted under `/runs/*` from the App shell, inside the workspace layout so the
 * behind-schema banner applies. Read-only: no write affordances render here.
 */
export function RunsRoute() {
  const { projectKey } = useActiveProject();
  const slug = useRunsSelection((s) => s.slug);
  const clearRun = useRunsSelection((s) => s.clearRun);

  const { data: runsData } = useQuery({
    queryKey: ["runs", projectKey],
    queryFn: api.runs,
  });
  const runCount = runsData?.runs.length ?? 0;

  // Drop a selection that points at a run absent from the active project so a
  // stale slug (e.g. after a project switch) doesn't 404 the detail panels.
  useEffect(() => {
    if (!slug || !runsData) return;
    if (!runsData.runs.some((r) => r.composite === slug)) clearRun();
  }, [slug, runsData, clearRun]);

  const sections: SidebarSection[] = [
    {
      key: "runs",
      title: "Runs",
      badge: runCount > 0 ? runCount : undefined,
      body: <RunsListPanel />,
      defaultOpen: true,
      grow: true,
    },
  ];

  return <Shell sidebar={<Sidebar sections={sections} />} inspector={<RunDetail />} />;
}

/** Right-pane run detail: a tab strip over the docs / brief / decisions panels.
 * Shows an empty prompt until a run is selected. */
function RunDetail() {
  const slug = useRunsSelection((s) => s.slug);
  const tab = useRunsSelection((s) => s.tab);
  const setTab = useRunsSelection((s) => s.setTab);

  if (!slug) return <Empty text="Select a run" />;

  return (
    <div className="flex flex-col h-full min-h-0">
      <nav
        aria-label="Run detail"
        className="shrink-0 flex items-stretch border-b border-bg-line bg-bg-deep"
      >
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            aria-current={tab === t.id ? "page" : undefined}
            className={cn(
              "px-4 h-9 text-[12px] font-mono tracking-wide2 font-semibold transition-colors border-r border-bg-line",
              tab === t.id
                ? "text-phos bg-bg-panel"
                : "text-fg-dim hover:text-fg-base hover:bg-bg-panel/60",
            )}
          >
            {t.label}
          </button>
        ))}
      </nav>
      <div className="flex-1 min-h-0">
        {tab === "docs" && <RunDocsPanel />}
        {tab === "brief" && <BriefPanel />}
        {tab === "decisions" && <RunDecisionsPanel />}
      </div>
    </div>
  );
}
