import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { RunList } from "./components/RunList";
import { StructurePanel } from "./components/StructurePanel";
import { FileList } from "./components/FileList";
import { RightPane } from "./components/RightPane";
import { StatusHeader } from "./components/StatusHeader";
import { StatusBar } from "./components/StatusBar";
import { CommandPalette } from "./components/CommandPalette";
import { Shell } from "./components/Shell";
import { Sidebar, type SidebarSection } from "./components/Sidebar";
import { ReviewSession } from "./components/review/ReviewSession";
import { useEventStream } from "./hooks/useEvents";
import { useHotkeys } from "./hooks/useHotkeys";
import { useSidebarSize } from "./hooks/useSidebarSize";
import { useUrlState } from "./hooks/useUrlState";
import { useSelection } from "./lib/store";
import { api } from "./lib/api";

export function App() {
  useEventStream();
  useUrlState();
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [paletteQuery, setPaletteQuery] = useState("");
  const openPalette = (q?: string) => {
    setPaletteQuery(q ?? "");
    setPaletteOpen(true);
  };
  useHotkeys({ onOpenPalette: () => openPalette() });

  const reviewMode = useSelection((s) => s.reviewMode);
  const slug = useSelection((s) => s.slug);

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

  return (
    <div className="h-full flex flex-col min-h-0">
      <StatusHeader onOpenPalette={openPalette} />
      <div className="flex-1 min-h-0">
        {reviewMode ? (
          <ReviewSession />
        ) : (
          <Shell sidebar={<Sidebar sections={sections} />} inspector={<RightPane />} />
        )}
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
