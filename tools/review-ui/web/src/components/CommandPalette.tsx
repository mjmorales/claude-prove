import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";
import { useSelection, type StructureTab, type RightTab } from "../lib/store";
import { cn } from "../lib/cn";

type Command = {
  id: string;
  label: string;
  hint?: string;
  group: string;
  run: () => void;
  score?: number;
};

export function CommandPalette({
  open,
  onClose,
  initialQuery = "",
}: {
  open: boolean;
  onClose: () => void;
  initialQuery?: string;
}) {
  const [q, setQ] = useState(initialQuery);
  const [idx, setIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  // Keep query in sync when the palette is re-opened with a new initialQuery
  // (e.g. the topbar search handed focus over).
  useEffect(() => {
    if (open) setQ(initialQuery);
  }, [open, initialQuery]);

  const { data: runs } = useQuery({ queryKey: ["runs"], queryFn: api.runs });

  const s = useSelection();

  const commands: Command[] = useMemo(() => {
    const out: Command[] = [];
    const structureTabs: Array<[StructureTab, string, string]> = [
      ["branches", "Branches", "1"],
      ["steps", "Steps", "2"],
      ["commits", "Commits", "3"],
      ["docs", "Docs", "4"],
      ["decisions", "Decisions", "5"],
    ];
    for (const [id, label, key] of structureTabs) {
      out.push({
        id: `panel:${id}`,
        label: `Open panel · ${label}`,
        hint: key,
        group: "PANEL",
        run: () => s.setStructureTab(id),
      });
    }
    const rightTabs: Array<[RightTab, string, string]> = [
      ["diff", "Diff", "d"],
      ["intent", "Intent", "i"],
      ["context", "Context", "c"],
    ];
    for (const [id, label, key] of rightTabs) {
      out.push({
        id: `view:${id}`,
        label: `View · ${label}`,
        hint: key,
        group: "VIEW",
        run: () => s.setRightTab(id),
      });
    }
    for (const r of runs?.runs ?? []) {
      out.push({
        id: `run:${r.slug}`,
        label: r.slug,
        hint: r.orchestratorBranch,
        group: "RUN",
        run: () => s.selectRun(r.slug),
      });
    }
    return out;
  }, [runs, s]);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return commands;
    return commands
      .map((c) => ({
        ...c,
        score: scoreMatch(needle, `${c.label} ${c.group} ${c.hint ?? ""}`.toLowerCase()),
      }))
      .filter((c) => (c.score ?? 0) > 0)
      .sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  }, [q, commands]);

  useEffect(() => {
    if (open) {
      setQ("");
      setIdx(0);
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  useEffect(() => {
    setIdx(0);
  }, [q]);

  if (!open) return null;

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") onClose();
    if (e.key === "ArrowDown" || (e.ctrlKey && e.key === "n")) {
      e.preventDefault();
      setIdx((i) => Math.min(filtered.length - 1, i + 1));
    } else if (e.key === "ArrowUp" || (e.ctrlKey && e.key === "p")) {
      e.preventDefault();
      setIdx((i) => Math.max(0, i - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const cmd = filtered[idx];
      if (cmd) {
        cmd.run();
        onClose();
      }
    }
  };

  return (
    <div
      className="fixed inset-0 z-[100] bg-bg-void/70 backdrop-blur-sm flex items-start justify-center pt-[18vh]"
      onClick={onClose}
    >
      <div
        className="w-[640px] max-w-[90vw] bg-bg-panel border border-bg-line rounded-lg shadow-phos overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-3 px-4 h-11 border-b border-bg-line">
          <span className="text-phos font-mono">›</span>
          <input
            ref={inputRef}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={onKey}
            placeholder="type a command or run slug…"
            className="flex-1 bg-transparent outline-none text-fg-bright text-[14px] font-mono placeholder:text-fg-dim"
          />
          <span className="kbd">ESC</span>
        </div>
        <ul className="max-h-[50vh] overflow-y-auto scrollbar-thin">
          {filtered.length === 0 && (
            <li className="px-4 py-6 text-center text-fg-dim text-[12px]">no matches</li>
          )}
          {filtered.map((c, i) => {
            const active = i === idx;
            return (
              <li
                key={c.id}
                onMouseEnter={() => setIdx(i)}
                onClick={() => {
                  c.run();
                  onClose();
                }}
                className={cn(
                  "px-4 py-2 flex items-center gap-3 cursor-pointer border-l-2",
                  active
                    ? "bg-bg-raised border-phos text-fg-bright"
                    : "border-transparent text-fg-base",
                )}
              >
                <span className="label w-16 shrink-0">{c.group}</span>
                <span className="flex-1 truncate font-mono text-[12.5px]">{c.label}</span>
                {c.hint && (
                  <span className="font-mono text-[10.5px] text-fg-dim truncate max-w-[200px]">
                    {c.hint}
                  </span>
                )}
                {active && <span className="kbd">↵</span>}
              </li>
            );
          })}
        </ul>
        <div className="h-7 px-4 flex items-center justify-between text-[10.5px] border-t border-bg-line text-fg-dim">
          <span>
            <span className="kbd">↑</span> <span className="kbd">↓</span> navigate
          </span>
          <span>{filtered.length} commands</span>
        </div>
      </div>
    </div>
  );
}

function scoreMatch(needle: string, haystack: string): number {
  if (!needle) return 1;
  let i = 0;
  let score = 0;
  let prev = -2;
  for (let j = 0; j < haystack.length && i < needle.length; j++) {
    if (haystack[j] === needle[i]) {
      score += j - prev === 1 ? 3 : 1;
      prev = j;
      i++;
    }
  }
  return i === needle.length ? score : 0;
}
