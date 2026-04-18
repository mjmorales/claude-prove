import type { GroupVerdict } from "../../lib/api";
import { tokenOf } from "./verdictTokens";
import { cn } from "../../lib/cn";

export function VerdictStrip({
  verdicts,
  cursor,
  onJump,
}: {
  verdicts: GroupVerdict[];
  cursor: number;
  onJump: (idx: number) => void;
}) {
  return (
    <div className="flex items-center gap-[3px] h-6 select-none">
      {verdicts.map((v, i) => {
        const t = tokenOf(v);
        const active = i === cursor;
        const filled = !!t;
        return (
          <button
            key={i}
            onClick={() => onJump(i)}
            title={`Group ${i + 1}${t ? ` — ${t.label}` : ""}`}
            className={cn(
              "belt-seg h-4 w-[10px] border border-bg-line/80",
              active && "active ring-1 ring-phos",
            )}
            style={{
              background: filled ? t!.color : "transparent",
              boxShadow: filled ? `0 0 8px -2px ${t!.color}` : undefined,
              borderColor: active ? "#bd93f9" : undefined,
            }}
          />
        );
      })}
    </div>
  );
}
