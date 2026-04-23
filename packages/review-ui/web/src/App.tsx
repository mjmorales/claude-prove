import { useEffect, useState } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import { StatusHeader } from "./components/StatusHeader";
import { StatusBar } from "./components/StatusBar";
import { CommandPalette } from "./components/CommandPalette";
import { useEventStream } from "./hooks/useEvents";
import { useHotkeys } from "./hooks/useHotkeys";
import { useSidebarSize } from "./hooks/useSidebarSize";
import { AcbRoute } from "./routes/acb";
import { ScrumRoute } from "./routes/scrum";

/**
 * App shell. Hosts persistent chrome (StatusHeader + StatusBar + CommandPalette)
 * plus global hotkeys/SSE, then delegates the main surface to route children.
 *
 * Routes:
 *   /        -> redirect to /acb
 *   /acb/*   -> ACB review experience (Shell + Sidebar + RightPane or ReviewSession)
 *   /scrum   -> placeholder stub (phase 12)
 */
export function App() {
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
          <Route path="/acb/*" element={<AcbRoute />} />
          <Route path="/scrum" element={<ScrumRoute />} />
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
