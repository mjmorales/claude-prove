import { useState } from "react";
import { RunList } from "./components/RunList";
import { StructurePanel } from "./components/StructurePanel";
import { FileList } from "./components/FileList";
import { RightPane } from "./components/RightPane";
import { StatusHeader } from "./components/StatusHeader";
import { StatusBar } from "./components/StatusBar";
import { CommandPalette } from "./components/CommandPalette";
import { ResizableColumns } from "./components/ResizableColumns";
import { ReviewSession } from "./components/review/ReviewSession";
import { useEventStream } from "./hooks/useEvents";
import { useHotkeys } from "./hooks/useHotkeys";
import { useSelection } from "./lib/store";

export function App() {
  useEventStream();
  const [palette, setPalette] = useState(false);
  useHotkeys({ onOpenPalette: () => setPalette(true) });
  const reviewMode = useSelection((s) => s.reviewMode);
  const slug = useSelection((s) => s.slug);
  const filePath = useSelection((s) => s.filePath);
  const commitSha = useSelection((s) => s.commitSha);
  const pendingMode = useSelection((s) => s.pendingMode);

  const hasRun = !!slug;
  const hasInspectorTarget = !!(filePath || commitSha || pendingMode);

  return (
    <div className="h-full flex flex-col min-h-0">
      <StatusHeader onOpenPalette={() => setPalette(true)} />
      <main className="flex-1 min-h-0">
        {reviewMode ? (
          <ReviewSession />
        ) : (
          <ResizableColumns
            columns={[
              { label: "Runs", node: <RunList /> },
              { label: "Structure", node: <StructurePanel />, visible: hasRun },
              { label: "Files", node: <FileList />, visible: hasRun },
              { label: "Inspector", node: <RightPane />, visible: hasRun && hasInspectorTarget },
            ]}
          />
        )}
      </main>
      <StatusBar />
      <CommandPalette open={palette} onClose={() => setPalette(false)} />
    </div>
  );
}
