/**
 * Shared empty-state placeholder for panel bodies.
 *
 * Renders a full-height, centered, dim single-line message. Every review-UI
 * panel uses this for "select a run", "no results", etc. so the typography
 * and vertical centering stay consistent across FileList, BranchTree,
 * CommitsPanel, DecisionsPanel, ContextPanel, and IntentsPanel.
 */
export function Empty({ text }: { text: string }) {
  return (
    <div className="flex h-full items-center justify-center text-fg-dim text-[13px]">
      {text}
    </div>
  );
}
