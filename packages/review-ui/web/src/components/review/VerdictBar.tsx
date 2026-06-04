import { VERDICTS } from "./verdictTokens";
import type { GroupVerdict } from "../../lib/api";
import { cn } from "../../lib/cn";
import { useWriteAffordancesDisabled } from "../BehindSchemaBanner";

type DecidedVerdict = Exclude<GroupVerdict, "pending">;

const ORDER: DecidedVerdict[] = [
  "accepted",
  "rejected",
  "needs_discussion",
  "rework",
];

export function VerdictBar({
  current,
  flashing,
  onPick,
  onUndo,
  canUndo,
}: {
  current: GroupVerdict;
  flashing: GroupVerdict | null;
  onPick: (v: DecidedVerdict) => void;
  onUndo: () => void;
  canUndo: boolean;
}) {
  // A store behind schema must not accept writes — a verdict written through a
  // stale schema risks corrupting records the server can no longer interpret.
  // OR this seam into every write control's disabled predicate so the bar goes
  // read-only the moment the active project reports behind-schema.
  const writesDisabled = useWriteAffordancesDisabled();
  return (
    <div className="flex items-center gap-2">
      {ORDER.map((key) => {
        const t = VERDICTS[key];
        const active = current === key;
        const flash = flashing === key;
        const live = active || flash;
        return (
          <button
            key={key}
            onClick={() => onPick(key)}
            disabled={writesDisabled}
            title={`${t.label} (${t.keycap})`}
            className={cn(
              "btn",
              live ? t.btnClass : "btn-ghost",
              flash && "ring-2 ring-offset-0",
              writesDisabled && "is-disabled",
            )}
            style={
              flash
                ? { boxShadow: `0 0 0 2px ${t.color}` }
                : undefined
            }
          >
            <span className="text-[15px] leading-none">{t.glyph}</span>
            <span className="font-semibold">{t.label}</span>
            <span className={cn("kbd", live && "kbd-on-solid")}>{t.keycap}</span>
          </button>
        );
      })}
      <div className="w-px h-6 bg-bg-line mx-1" />
      <button
        onClick={onUndo}
        disabled={!canUndo || writesDisabled}
        title="Undo (u)"
        className={cn("btn btn-subtle", (!canUndo || writesDisabled) && "is-disabled")}
      >
        <span className="text-[13px] leading-none">↶</span>
        <span>Undo</span>
        <span className="kbd">u</span>
      </button>
    </div>
  );
}
