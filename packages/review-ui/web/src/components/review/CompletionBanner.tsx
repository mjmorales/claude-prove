import type { GroupVerdict } from "../../lib/api";
import { VERDICTS } from "./verdictTokens";

export function CompletionBanner({
  total,
  tally,
  onExit,
}: {
  total: number;
  tally: Record<Exclude<GroupVerdict, "pending">, number>;
  onExit: () => void;
}) {
  // `rejected` here tallies both hard rejections and rework requests —
  // both indicate work the user flagged as not ready to merge as-is.
  const rejected = tally.rejected + tally.rework;
  const clean = rejected === 0;
  const statusColor = clean ? "#50fa7b" : "#ffb86c";
  const headline = clean ? "Review complete" : "Review complete · action needed";
  const subline = clean
    ? "Everything looks good. Nothing to fix."
    : `${rejected} group${rejected === 1 ? "" : "s"} flagged for follow-up.`;

  return (
    <div className="h-full flex items-center justify-center p-10">
      <div
        className="rack-in card-face max-w-2xl w-full p-10 text-center"
        style={{
          boxShadow: `inset 0 0 0 1px ${statusColor}44, 0 28px 60px -32px ${statusColor}55`,
        }}
      >
        <div
          className="inline-flex items-center justify-center w-14 h-14 rounded-full mb-5"
          style={{ background: `${statusColor}22`, color: statusColor }}
        >
          <span className="text-[28px]">{clean ? "✓" : "!"}</span>
        </div>
        <div className="text-[22px] font-semibold text-fg-bright mb-2">{headline}</div>
        <div className="text-[13.5px] text-fg-dim mb-8">{subline}</div>

        <div className="grid grid-cols-4 gap-3 mb-10">
          {(Object.keys(VERDICTS) as Array<keyof typeof VERDICTS>).map((k) => {
            const t = VERDICTS[k];
            const val = tally[k];
            return (
              <div
                key={k}
                className="rounded-md border border-bg-line bg-bg-deep/60 px-3 py-3 text-left"
                style={{ borderTop: `2px solid ${t.color}` }}
              >
                <div
                  className="font-mono text-[26px] tabular-nums leading-none"
                  style={{ color: val > 0 ? t.color : "#6272a4" }}
                >
                  {val}
                </div>
                <div
                  className="mt-2 text-[11.5px]"
                  style={{ color: val > 0 ? t.color : "#6272a4" }}
                >
                  {t.label}
                </div>
              </div>
            );
          })}
        </div>

        <div className="flex items-center justify-center gap-3">
          <button onClick={onExit} className="btn btn-primary btn-lg">
            <span>Back to inspector</span>
            <span className="kbd kbd-on-solid">e</span>
          </button>
        </div>
        <div className="text-[11.5px] text-fg-faint mt-4">
          {total} intent group{total === 1 ? "" : "s"} reviewed
        </div>
      </div>
    </div>
  );
}
