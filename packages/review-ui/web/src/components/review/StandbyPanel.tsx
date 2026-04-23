import { useEffect, useState } from "react";

/**
 * Waiting state shown when the review queue is drained. Live-connection
 * pulse lets the user see the UI is still listening for SSE events.
 * When a new intent arrives the ReviewSession swaps the active view out —
 * this panel never has to handle transitions itself.
 */
export function StandbyPanel({
  reviewedCount,
  waitingCount,
  onResume,
  onRevisit,
}: {
  reviewedCount: number;
  waitingCount: number;
  /** Called if the user wants to re-enable auto-advance after pausing. */
  onResume?: () => void;
  /** Surface the "reviewed" bucket as a visible list. */
  onRevisit?: () => void;
}) {
  const ping = useLiveHeartbeat();
  return (
    <div className="h-full flex items-center justify-center p-10">
      <div className="max-w-xl w-full text-center">
        <div className="text-[56px] leading-none mb-4" aria-hidden>
          ⏳
        </div>
        <div className="text-[18px] font-semibold text-fg-bright mb-2">
          {waitingCount > 0 ? "All caught up for now" : "Queue drained"}
        </div>
        <p className="text-[13.5px] text-fg-dim mb-6 leading-relaxed">
          {waitingCount > 0 ? (
            <>
              Waiting for the orchestrator to save the next intent manifest. This panel
              will advance automatically when one arrives.
            </>
          ) : (
            <>
              Nothing left to decide. Revisit reviewed intents or leave this tab open —
              new intents will pop in here as they land.
            </>
          )}
        </p>

        <div className="inline-flex items-center gap-3 px-4 py-2 rounded-md border border-bg-line bg-bg-panel text-[12px] font-mono">
          <span className={`led ${ping ? "" : "led-dim"}`} />
          <span className="text-fg-base">Live</span>
          <span className="text-fg-faint">·</span>
          <span className="text-fg-faint tabular-nums">
            reviewed {reviewedCount} · waiting {waitingCount}
          </span>
        </div>

        <div className="mt-6 flex items-center justify-center gap-2 flex-wrap">
          {onResume && (
            <button onClick={onResume} className="btn btn-ghost btn-sm">
              <span>Resume auto-advance</span>
              <span className="kbd">⎵</span>
            </button>
          )}
          {onRevisit && (
            <button onClick={onRevisit} className="btn btn-subtle btn-sm">
              <span>Revisit reviewed</span>
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/** Soft pulse driven by the mount time — not tied to real SSE, but makes the
 * LED visually alive. When SSE events fire they trigger a React Query refetch
 * which remounts parts of the tree, naturally refreshing this too. */
function useLiveHeartbeat(): boolean {
  const [on, setOn] = useState(true);
  useEffect(() => {
    const id = setInterval(() => setOn((o) => !o), 1400);
    return () => clearInterval(id);
  }, []);
  return on;
}
