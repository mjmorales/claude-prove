import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { RunList } from "../../components/RunList";
import { StructurePanel } from "../../components/StructurePanel";
import { FileList } from "../../components/FileList";
import { RightPane } from "../../components/RightPane";
import { Shell } from "../../components/Shell";
import { Sidebar, type SidebarSection } from "../../components/Sidebar";
import { ReviewSession } from "../../components/review/ReviewSession";
import { useUrlState } from "../../hooks/useUrlState";
import { useSelection } from "../../lib/store";
import { api } from "../../lib/api";

/**
 * ACB review experience. Composes the existing Shell + Sidebar + RightPane
 * layout, or ReviewSession when `reviewMode` is on. Owns the ?run=<slug>
 * query-string sync via `useUrlState` so the hook only mounts while /acb is
 * the active route.
 */
export function AcbRoute() {
  useUrlState();

  const reviewMode = useSelection((s) => s.reviewMode);
  const slug = useSelection((s) => s.slug);

  const { data: runsData } = useQuery({ queryKey: ["runs"], queryFn: api.runs });
  const runCount = runsData?.runs.length ?? 0;

  // Clear selection if the URL referenced a run that no longer exists — avoids
  // cascade of 404s against a stale slug when a cleaned-up bookmark is opened.
  useEffect(() => {
    if (!slug || !runsData) return;
    const exists = runsData.runs.some((r) => r.composite === slug);
    if (!exists) {
      useSelection.setState({
        slug: null,
        branch: null,
        base: null,
        head: null,
        filePath: null,
        pendingMode: false,
        commitSha: null,
      });
    }
  }, [slug, runsData]);

  const sections: SidebarSection[] = [
    {
      key: "runs",
      title: "Runs",
      badge: runCount > 0 ? runCount : undefined,
      body: <RunList />,
      defaultOpen: true,
      grow: !slug,
    },
    ...(slug
      ? ([
          {
            key: "structure",
            title: "Structure",
            body: <StructurePanel />,
            defaultOpen: true,
            grow: true,
          },
          { key: "files", title: "Files", body: <FileList />, defaultOpen: true, grow: true },
        ] as SidebarSection[])
      : []),
  ];

  if (reviewMode) {
    return <ReviewSession />;
  }
  return <Shell sidebar={<Sidebar sections={sections} />} inspector={<RightPane />} />;
}
